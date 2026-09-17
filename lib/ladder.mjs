#!/usr/bin/env node
/**
 * Working orders — resting limit orders that trade while nobody is running this.
 *
 * WHY THIS EXISTS
 * ---------------
 * Erik runs the agent roughly once a day. Between runs the book had ZERO open orders,
 * so for ~23 hours a day nothing could happen. The single mechanism in the first month
 * that made money was a set of resting bids below market: five fills, five profitable.
 * A trend filter switched it off and it never came back. The book now always carries
 * working orders.
 *
 * This is NOT a grid (Erik: "its dumb and i can setup grid myself"). Levels are picked
 * per run from recent structure — the 7-day range — and judgement decides whether to
 * place them. `plan` proposes; a human-confirmed `place` executes.
 *
 * Spot only, on BTC and ETH by default: they trade continuously, so a resting order
 * never sits on a halted book. (Tokenized spot halts on weekends.)
 *
 * Usage:
 *   node lib/ladder.mjs plan   [BTC ETH ...] [--cash 20]
 *   node lib/ladder.mjs place  '[{"symbol":"BTC_USDT","side":"BUY","price":74010,"size":0.000148}]'
 *   node lib/ladder.mjs status [BTC ETH ...]
 *   node lib/ladder.mjs cancel SYMBOL
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.pionex.com";
const PROFILE = "pionx-prod";

const cli = (args) =>
  JSON.parse(execFileSync("pionex-trade-cli", ["--profile", PROFILE, ...args], { encoding: "utf8", shell: true }));
const j = (u) => fetch(API + u).then((r) => r.json());

const argList = process.argv.slice(3).filter((a) => !a.startsWith("--") && !/^[\d.]+$/.test(a));
const cashArg = (() => { const i = process.argv.indexOf("--cash"); return i > 0 ? Number(process.argv[i + 1]) : null; })();
const bases = (argList.length ? argList : ["BTC", "ETH"]).map((b) => b.toUpperCase().replace(/_USDT$/, ""));

// Place orders just ABOVE a round number for bids and just BELOW one for offers:
// a 2,440.00 bid once missed a 2,440.01 low by one cent. Crowds cluster on round prices.
export function roundUnit(price) {
  if (price >= 20000) return 250;
  if (price >= 2000) return 10;
  if (price >= 200) return 1;
  if (price >= 20) return 0.1;
  return 0.01;
}
export function bidAbove(level, price) {
  const u = roundUnit(price);
  return Math.floor(level / u) * u + u * 0.04;
}
export function offerBelow(level, price) {
  const u = roundUnit(price);
  return Math.ceil(level / u) * u - u * 0.04;
}
const floorTo = (x, dp) => Math.floor(x * 10 ** dp) / 10 ** dp;

function wallet() {
  const w = cli(["wallet", "balance_full"]);
  const spot = w.data.botAccount.detail.find((d) => d.type === "spot");
  const by = Object.fromEntries((spot?.list ?? []).map((r) => [r.coin, r]));
  return { by, freeUsdt: Number(by.USDT?.free ?? 0) };
}

async function plan() {
  const w = wallet();
  let cash = cashArg ?? w.freeUsdt;
  const proposals = [];
  const report = [];
  for (const base of bases) {
    const sym = `${base}_USDT`;
    const [t, s, k] = await Promise.all([
      j(`/api/v1/market/tickers?symbol=${sym}`),
      j(`/api/v1/common/symbols?symbols=${sym}`),
      j(`/api/v1/market/klines?symbol=${sym}&interval=1D&limit=8`),
    ]);
    const price = Number(t.data.tickers[0].close);
    const spec = s.data.symbols[0];
    const bars = k.data.klines;
    const hi7 = Math.max(...bars.map((b) => Number(b.high)));
    const lo7 = Math.min(...bars.map((b) => Number(b.low)));
    const dp = spec.basePrecision;
    const min = Number(spec.minAmount);
    const held = Number(w.by[base]?.free ?? 0);

    // Bid: 40% of the way down to the 7-day low, never closer than 1.5% to market.
    const bidLvl = Math.min(price - 0.4 * (price - lo7), price * 0.985);
    const bid = bidAbove(bidLvl, price);
    const bidUsdt = min * 1.08;
    // Offer: 70% of the way up to the 7-day high, never closer than 2% to market.
    const offLvl = Math.max(price + 0.7 * (hi7 - price), price * 1.02);
    const offer = offerBelow(offLvl, price);
    const offSize = floorTo(Math.max(held * 0.2, (min * 1.05) / offer), dp);

    const row = {
      base, price, lo7, hi7, heldQty: held, heldUsdt: +(held * price).toFixed(2),
      bid: +bid.toFixed(spec.quotePrecision), bidPctBelow: +(((price - bid) / price) * 100).toFixed(2),
      offer: +offer.toFixed(spec.quotePrecision), offerPctAbove: +(((offer - price) / price) * 100).toFixed(2),
    };
    report.push(row);

    if (cash >= bidUsdt) {
      proposals.push({ symbol: sym, side: "BUY", price: row.bid, size: floorTo(bidUsdt / bid, dp), usdt: +bidUsdt.toFixed(2) });
      cash -= bidUsdt;
    } else {
      row.bidSkipped = `needs ${bidUsdt.toFixed(2)} USDT free, have ${cash.toFixed(2)}`;
    }
    if (offSize * offer >= min && offSize <= held) {
      proposals.push({ symbol: sym, side: "SELL", price: row.offer, size: offSize, usdt: +(offSize * offer).toFixed(2) });
    } else {
      row.offerSkipped = `holding too small for a ${min} USDT order`;
    }
  }
  return { freeUsdt: w.freeUsdt, levels: report, proposals };
}

async function place(list) {
  const results = [];
  for (const o of list) {
    const notional = Number(o.price) * Number(o.size);
    const pf = {
      action: o.side === "BUY" ? "ADD" : "REDUCE",
      symbol: o.symbol, notional_usdt: +notional.toFixed(2), leverage: 1, confidence: "MEDIUM",
      sources: [`${API}/api/v1/market/klines`],
      reasoning: o.reason ?? `Resting ${o.side} at ${o.price} from 7-day structure so the book trades while unattended.`,
    };
    try {
      execFileSync("node", ["lib/preflight.mjs", JSON.stringify(pf)], { cwd: ROOT, encoding: "utf8" });
    } catch (e) {
      results.push({ ...o, result: "PREFLIGHT REJECTED", detail: (e.stdout ?? e.message).trim() });
      continue;
    }
    const r = cli(["orders", "new", "--symbol", o.symbol, "--side", o.side, "--type", "LIMIT", "--price", String(o.price), "--size", String(o.size)]);
    const entry = { ...o, result: r.result === false ? `REJECTED ${r.code} ${r.message}` : "RESTING", orderId: r.data?.orderId };
    results.push(entry);
    logOrder({ action: pf.action, symbol: o.symbol, type: "LIMIT", side: o.side, price: o.price, size: o.size, notional_usdt: pf.notional_usdt, orderId: entry.orderId, result: entry.result, strategy: "working-order", reasoning: pf.reasoning });
  }
  return results;
}

function logOrder(entry) {
  const day = new Date().toISOString().slice(0, 10);
  const p = resolve(ROOT, "trades", `${day}.json`);
  const doc = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { date: day, orders: [] };
  doc.orders = doc.orders ?? [];
  doc.orders.push({ ts: new Date().toISOString(), ...entry });
  writeFileSync(p, JSON.stringify(doc, null, 2));
}

function status() {
  const out = [];
  for (const base of bases) {
    const sym = `${base}_USDT`;
    const open = cli(["orders", "open", "--symbol", sym]).data?.orders ?? [];
    const fills = cli(["orders", "fills", "--symbol", sym]).data?.fills ?? [];
    out.push({
      symbol: sym,
      open: open.map((o) => ({ orderId: o.orderId, side: o.side, price: Number(o.price), size: Number(o.size), filled: Number(o.filledSize ?? 0) })),
      recentFills: fills.slice(0, 5).map((f) => ({ side: f.side, price: Number(f.price), size: Number(f.size), time: new Date(Number(f.timestamp)).toISOString() })),
    });
  }
  return out;
}

// ---- CLI -----------------------------------------------------------------
if (process.argv[1]?.endsWith("ladder.mjs")) {
  const cmd = process.argv[2];
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  const run = {
    plan: () => plan().then(out),
    place: () => place(JSON.parse(process.argv[3])).then(out),
    status: async () => out(status()),
    cancel: async () => out(cli(["orders", "cancel_all", "--symbol", `${bases[0]}_USDT`])),
  }[cmd];
  if (!run) {
    console.error("usage: node lib/ladder.mjs <plan [BASES] [--cash N] | place '<json>' | status [BASES] | cancel BASE>");
    process.exit(2);
  }
  Promise.resolve(run()).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
