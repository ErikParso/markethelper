#!/usr/bin/env node
/**
 * Delta-neutral funding carry: long spot + short perp (1x isolated), collect funding.
 *
 * WHY THIS EXISTS
 * ---------------
 * Erik asked for money that EARNS, not money that waits for a call to be right. On this
 * venue the one income source that does not need a directional view is perp funding:
 * when longs are crowded, shorts are paid every 8 hours. Holding the same size long in
 * spot cancels the price exposure, so what is left is the funding stream (plus basis).
 *
 * Risks this tool exists to manage, not to hide:
 *   - Funding flips negative → the carry starts COSTING. `status` shows it daily.
 *   - The two legs sit in DIFFERENT wallets. A violent rally can liquidate the short
 *     even though spot covers it economically. 1x isolated needs roughly a doubling.
 *   - Tokenized spot (CRCLX, BMNRX, NVDAX…) HALTS on weekends while the perp trades.
 *     The hedge still holds, but the spot leg cannot be adjusted or closed. This tool
 *     refuses to OPEN a tokenized carry on a weekend.
 *   - Legs are opened spot-first and closed perp-first, so a half-failed order leaves a
 *     plain long (tolerable), never a naked short.
 *
 * Usage:
 *   node lib/carry.mjs plan   BASE USDT      # e.g. plan BNB 40 — no orders
 *   node lib/carry.mjs open   BASE USDT      # ONLY after Erik confirms the plan
 *   node lib/carry.mjs status
 *   node lib/carry.mjs close  BASE           # ONLY after Erik confirms
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as perp from "./perp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.pionex.com";
const PROFILE = "pionx-prod";
const FEE = 0.0005; // per leg per side, conservative
const MARGIN_BUFFER = 1.05; // isolated margin = notional × this, covers fees

const cli = (args) =>
  JSON.parse(execFileSync("pionex-trade-cli", ["--profile", PROFILE, ...args], { encoding: "utf8", shell: true }));
const node = (args) => execFileSync("node", args, { cwd: ROOT, encoding: "utf8" });

const isTokenized = (base) => /^[A-Z]{2,6}X$/.test(base) && !["PAXG", "IMX", "STX", "ZRX", "CVX"].includes(base);
const weekend = () => [0, 6].includes(new Date().getUTCDay());

async function spotInfo(base) {
  const sym = `${base}_USDT`;
  const [t, s] = await Promise.all([
    fetch(`${API}/api/v1/market/tickers?symbol=${sym}`).then((r) => r.json()),
    fetch(`${API}/api/v1/common/symbols?symbols=${sym}`).then((r) => r.json()),
  ]);
  const tk = t?.data?.tickers?.[0];
  const sp = s?.data?.symbols?.[0];
  if (!tk || !sp) throw new Error(`no spot market ${sym}`);
  return { symbol: sym, price: Number(tk.close), spec: sp };
}

function spotHolding(base) {
  const w = cli(["wallet", "balance_full"]);
  const spot = w.data.botAccount.detail.find((d) => d.type === "spot");
  const row = spot?.list?.find((r) => r.coin === base);
  const usdt = spot?.list?.find((r) => r.coin === "USDT");
  return { qty: Number(row?.free ?? 0), freeUsdt: Number(usdt?.free ?? 0) };
}

function logOrder(entry) {
  const day = new Date().toISOString().slice(0, 10);
  const p = resolve(ROOT, "trades", `${day}.json`);
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  const j = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { date: day, orders: [] };
  j.orders = j.orders ?? [];
  j.orders.push({ ts: new Date().toISOString(), ...entry });
  writeFileSync(p, JSON.stringify(j, null, 2));
}

function preflight(o) {
  try {
    return node(["lib/preflight.mjs", JSON.stringify(o)]);
  } catch (e) {
    throw new Error(`preflight REJECTED ${o.action} ${o.symbol}:\n${e.stdout ?? e.message}`);
  }
}

async function plan(base, usdt) {
  base = base.toUpperCase();
  const [s, pm, ps] = await Promise.all([spotInfo(base), perp.market(base), perp.specs(base)]);
  const notional = usdt / (1 + MARGIN_BUFFER);
  const size = perp.roundStep(notional / s.price, ps.baseStep);
  const legSpot = size * s.price;
  const margin = size * pm.mark * MARGIN_BUFFER;
  const perDay = size * pm.mark * pm.funding * 3;
  const fees = 2 * FEE * (legSpot + size * pm.mark); // open + close, both legs
  const basis = (pm.mark - s.price) / s.price;
  const problems = [];
  if (legSpot < Number(s.spec.minAmount)) problems.push(`spot leg ${legSpot.toFixed(2)} below spot minimum ${s.spec.minAmount} — need ≥ ${(Number(s.spec.minAmount) * (1 + MARGIN_BUFFER)).toFixed(0)} USDT`);
  if (pm.funding <= 0) problems.push(`funding is ${(pm.funding * 100).toFixed(4)}% — shorts are PAYING, carry would cost money`);
  if (!s.spec.enable) problems.push(`spot ${s.symbol} is not enabled`);
  if (ps.status !== "TRADING") problems.push(`perp status ${ps.status}`);
  if (isTokenized(base) && weekend()) problems.push(`tokenized spot is HALTED on weekends — cannot open`);
  return {
    base, capital: usdt, size, spotPrice: s.price, perpMark: pm.mark,
    spotLegUsdt: +legSpot.toFixed(2), futuresMarginUsdt: +margin.toFixed(2),
    fundingPer8h: pm.funding, fundingYrPct: +(pm.funding * 3 * 365 * 100).toFixed(1),
    expectedPerDayUsdt: +perDay.toFixed(4), roundTripFeesUsdt: +fees.toFixed(3),
    breakevenDays: perDay > 0 ? +(fees / perDay).toFixed(1) : null,
    basisPct: +(basis * 100).toFixed(3),
    approxLiquidation: +(pm.mark * 1.95).toFixed(2),
    tokenized: isTokenized(base),
    perpVolume24h: pm.volume24hUsdt,
    problems,
  };
}

async function open(base, usdt) {
  const p = await plan(base, usdt);
  if (p.problems.length) throw new Error(`refusing to open:\n  - ${p.problems.join("\n  - ")}`);
  const hold = spotHolding(p.base);
  if (hold.freeUsdt < p.spotLegUsdt + p.futuresMarginUsdt - 0.01) {
    throw new Error(`need ${(p.spotLegUsdt + p.futuresMarginUsdt).toFixed(2)} USDT free in spot, have ${hold.freeUsdt.toFixed(2)}`);
  }
  const reason = `Delta-neutral funding carry on ${p.base}: long spot + short perp at 1x isolated, collecting ${p.fundingYrPct}%/yr while funding stays positive.`;
  preflight({ action: "OPEN_LONG", symbol: `${p.base}_USDT`, notional_usdt: p.spotLegUsdt, leverage: 1, confidence: "HIGH", sources: [`${API}/api/v1/market/indexes`], reasoning: reason });
  preflight({ action: "OPEN_SHORT", symbol: `${p.base}_USDT_PERP`, notional_usdt: p.spotLegUsdt, leverage: 1, confidence: "HIGH", sources: [`${API}/api/v1/market/indexes`], reasoning: reason });

  // 1. margin to futures, 2. prove 1x isolated, 3. spot first, 4. perp sized to what spot actually filled.
  node(["lib/transfer.mjs", String(p.futuresMarginUsdt), "MAIN", "TRADE"]);
  await perp.ensureSafe(p.base);

  const spotBuy = cli(["orders", "new", "--symbol", `${p.base}_USDT`, "--side", "BUY", "--type", "MARKET", "--amount", String(p.spotLegUsdt)]);
  if (spotBuy.result === false) throw new Error(`spot buy failed: ${spotBuy.code} ${spotBuy.message} — margin is sitting in futures, move it back with lib/transfer.mjs`);
  logOrder({ action: "OPEN_LONG", symbol: `${p.base}_USDT`, type: "MARKET", side: "BUY", notional_usdt: p.spotLegUsdt, orderId: spotBuy.data?.orderId, result: "FILLED", strategy: "carry", reasoning: reason });

  await new Promise((r) => setTimeout(r, 1500));
  const filled = spotHolding(p.base).qty - hold.qty;
  const ps = await perp.specs(p.base);
  const shortSize = perp.roundStep(filled, ps.baseStep);
  const short = await perp.order({ symbol: p.base, side: "SELL", size: shortSize });
  logOrder({ action: "OPEN_SHORT", symbol: `${p.base}_USDT_PERP`, type: "MARKET_QTY", side: "SELL", size: shortSize, leverage: 1, orderId: short.response?.orderId, result: "FILLED", strategy: "carry", reasoning: reason });

  await new Promise((r) => setTimeout(r, 1500));
  return status();
}

async function status() {
  const pos = await perp.positions();
  const rows = [];
  for (const x of pos) {
    const base = x.symbol.replace(/_USDT_PERP$/, "");
    const m = await perp.market(base);
    const hold = spotHolding(base).qty;
    const net = Number(x.netSize);
    rows.push({
      base,
      perpSize: net,
      spotQty: +hold.toFixed(6),
      hedgeRatio: net < 0 && hold > 0 ? +(hold / -net).toFixed(3) : null,
      avgPrice: Number(x.avgPrice),
      mark: m.mark,
      unrealizedPnL: Number(x.unrealizedPnL ?? x.unrealizedPnl ?? 0),
      liquidationPrice: Number(x.liquidationPrice),
      liqDistancePct: x.liquidationPrice ? +(((Number(x.liquidationPrice) - m.mark) / m.mark) * 100).toFixed(1) : null,
      leverage: x.leverage,
      fundingPer8h: m.funding,
      fundingYrPct: +(m.funding * 3 * 365 * 100).toFixed(1),
      collectingPerDayUsdt: +(-net * m.mark * m.funding * 3).toFixed(4),
      warning: m.funding < 0 && net < 0 ? "FUNDING NEGATIVE — this carry is now costing money" : null,
    });
  }
  return rows;
}

async function close(base) {
  base = base.toUpperCase();
  const pos = (await perp.positions()).find((x) => x.symbol === `${base}_USDT_PERP`);
  const reason = `Closing ${base} funding carry.`;
  // Perp FIRST: a failed spot sell afterwards leaves a plain long, never a naked short.
  if (pos && Number(pos.netSize) < 0) {
    const size = -Number(pos.netSize);
    preflight({ action: "CLOSE", symbol: `${base}_USDT_PERP`, notional_usdt: size * Number(pos.avgPrice), leverage: 1, confidence: "HIGH", sources: [`${API}/api/v1/market/indexes`], reasoning: reason });
    const r = await perp.order({ symbol: base, side: "BUY", size, reduceOnly: true });
    logOrder({ action: "CLOSE", symbol: `${base}_USDT_PERP`, type: "MARKET_QTY", side: "BUY", size, orderId: r.response?.orderId, result: "FILLED", strategy: "carry", reasoning: reason });
  }
  if (isTokenized(base) && weekend()) {
    return { closed: "perp only", note: "tokenized spot is halted on weekends — sell the spot leg on the next weekday run" };
  }
  const s = await spotInfo(base);
  const qty = spotHolding(base).qty;
  const size = Math.floor(qty * 10 ** s.spec.basePrecision) / 10 ** s.spec.basePrecision;
  if (size * s.price >= Number(s.spec.minAmount)) {
    preflight({ action: "CLOSE", symbol: s.symbol, notional_usdt: size * s.price, leverage: 1, confidence: "HIGH", sources: [`${API}/api/v1/market/tickers`], reasoning: reason });
    const r = cli(["orders", "new", "--symbol", s.symbol, "--side", "SELL", "--type", "MARKET", "--size", String(size)]);
    if (r.result === false) throw new Error(`spot sell failed: ${r.code} ${r.message}`);
    logOrder({ action: "CLOSE", symbol: s.symbol, type: "MARKET", side: "SELL", size, orderId: r.data?.orderId, result: "FILLED", strategy: "carry", reasoning: reason });
  }
  return { closed: base, note: "move leftover futures margin back with: node lib/transfer.mjs <amt> TRADE MAIN" };
}

// ---- CLI -----------------------------------------------------------------
if (process.argv[1]?.endsWith("carry.mjs")) {
  const [, , cmd, base, amt] = process.argv;
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  const run = {
    plan: () => plan(base, Number(amt)).then(out),
    open: () => open(base, Number(amt)).then(out),
    status: () => status().then(out),
    close: () => close(base).then(out),
  }[cmd];
  if (!run || ((cmd === "plan" || cmd === "open") && !(Number(amt) > 0))) {
    console.error("usage: node lib/carry.mjs <plan BASE USDT | open BASE USDT | status | close BASE>");
    process.exit(2);
  }
  run().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
