#!/usr/bin/env node
/**
 * Earn products — the spot-account way to be paid while waiting.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-17 every perp order was denied ("TRADE_TYPE_DENIED — user denied not in
 * whitelist"), which killed the funding-carry sleeve and all shorting. Two Pionex Earn
 * products do much of the same job without touching the futures API:
 *
 *   ARBITRAGE  Pionex's own spot-futures funding arbitrage. USDT in, direction-neutral
 *              yield out (~6–8% APR on 2026-09-17). This IS the carry sleeve, run by them.
 *
 *   DUAL       A settlement-date order that pays a premium whether or not it fills.
 *              "buy"  (put, DUAL_CURRENCY): commit USDT at a strike BELOW market. Earn the
 *                     premium; if the price settles below the strike you receive the coin
 *                     at the strike. A resting bid that is paid to wait.
 *              "sell" (call, DUAL_BASE): commit held coin at a strike ABOVE market. Earn the
 *                     premium; if it settles above, the coin is sold at the strike.
 *
 * Dual caveats that change how it is used, and are NOT optional reading:
 *   - It settles on the EXPIRY price (08:00 UTC), not on an intraday touch. A dip that
 *     recovers before expiry does not fill it.
 *   - Once active it is LOCKED until expiry. Only a pending order can be revoked.
 *   - A buy-low can deliver a coin that has fallen far below the strike. It is a bid, with
 *     a bid's downside.
 *   - `profit` from the prices call is the yield for the whole term, not an APR. This tool
 *     annualises it for comparison only.
 *
 * Usage:
 *   node lib/earn.mjs arb products
 *   node lib/earn.mjs arb balances
 *   node lib/earn.mjs arb stake   PRODUCT_ID USDT      # after Erik confirms
 *   node lib/earn.mjs arb unstake PRODUCT_ID USDT      # after Erik confirms
 *   node lib/earn.mjs dual scan   BASE buy|sell [--max-days 16]
 *   node lib/earn.mjs dual invest PRODUCT_ID AMOUNT    # USDT for a buy, coin for a sell; after confirmation
 *   node lib/earn.mjs dual positions
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = "pionx-prod";
const DAY = 86400000;

const cli = (args) => {
  const r = JSON.parse(execFileSync("pionex-trade-cli", ["--profile", PROFILE, ...args], { encoding: "utf8", shell: true }));
  if (r?.result === false) throw new Error(`${args.slice(0, 3).join(" ")}: ${r.code} ${r.message}`);
  return r.data;
};
const spotPrice = async (base) =>
  Number((await fetch(`https://api.pionex.com/api/v1/market/tickers?symbol=${base}_USDT`).then((r) => r.json())).data.tickers[0].close);

// ---- arbitrage -------------------------------------------------------------
export function arbProducts() {
  return (cli(["earn", "arbitrage", "fetchProducts"]).products ?? []).map((p) => ({
    id: p.productId, name: p.productName, desc: p.productDesc, coin: p.coin,
    aprNow: +(Number(p.apr) * 100).toFixed(2),
    apr7d: +Number(p.publicLendingApr?.sevenDayApr ?? 0).toFixed(2),
    apr30d: +Number(p.publicLendingApr?.thirtyDayApr ?? 0).toFixed(2),
  }));
}
export function arbBalances() {
  return cli(["earn", "arbitrage", "fetchUserBalances"]).data ?? [];
}
export function arbMove(kind, productId, amount) {
  const p = arbProducts().find((x) => x.id === String(productId));
  if (!p) throw new Error(`no arbitrage product ${productId}`);
  const reasoning = `${kind === "stake" ? "Stake" : "Unstake"} ${amount} USDT ${kind === "stake" ? "into" : "from"} Pionex Earn Arbitrage "${p.name}" (${p.apr30d}% 30-day APR): direction-neutral funding yield, standing in for the carry sleeve while perp orders are denied.`;
  const pf = { action: kind === "stake" ? "BOT_CREATE" : "BOT_CANCEL", symbol: `USDT_EARN_ARB_${productId}`, notional_usdt: Number(amount), leverage: 1, confidence: "HIGH", sources: ["pionex-trade-cli earn arbitrage fetchProducts"], reasoning };
  try {
    execFileSync("node", ["lib/preflight.mjs", JSON.stringify(pf)], { cwd: ROOT, encoding: "utf8" });
  } catch (e) {
    throw new Error(`preflight REJECTED:\n${e.stdout ?? e.message}`);
  }
  const r = cli(["earn", "arbitrage", kind === "stake" ? "stake" : "unStake", "--product-id", String(productId), "--coin", "USDT", "--amount", String(amount), "--unique-id", randomUUID().replace(/-/g, "").slice(0, 32)]);
  logOrder({ action: pf.action, symbol: pf.symbol, type: "EARN_ARB", side: kind === "stake" ? "STAKE" : "UNSTAKE", notional_usdt: Number(amount), result: "OK", strategy: "earn-arb", reasoning });
  return r;
}

// ---- dual ------------------------------------------------------------------
// productId: BASE-USDXO-YYMMDD-STRIKE-P|C-USDT
const parseId = (id) => {
  const [base, quote, ymd, strike, pc, currency] = id.split("-");
  const expiry = Date.UTC(2000 + +ymd.slice(0, 2), +ymd.slice(2, 4) - 1, +ymd.slice(4, 6), 8);
  return { base, quote, ymd, strike: Number(strike), side: pc === "P" ? "buy" : "sell", currency, expiry };
};

export async function dualScan(base, side, maxDays = 16) {
  base = base.toUpperCase();
  const type = side === "buy" ? "DUAL_CURRENCY" : "DUAL_BASE";
  const products = cli(["earn", "dual", "open_products", "--base", base, "--quote", "USDXO", "--type", type, "--currency", "USDT"]).products ?? [];
  const px = await spotPrice(base);
  const now = Date.now();
  const ids = products
    .map((p) => ({ id: p.productId, ...parseId(p.productId) }))
    .filter((p) => p.side === side && p.expiry > now && p.expiry - now <= maxDays * DAY)
    .filter((p) => (side === "buy" ? p.strike < px : p.strike > px))
    .filter((p) => Math.abs(p.strike - px) / px <= 0.08);
  const quotes = [];
  for (let i = 0; i < ids.length; i += 5) {
    const chunk = ids.slice(i, i + 5);
    const r = cli(["earn", "dual", "prices", "--base", base, "--quote", "USDXO", "--product-ids", chunk.map((c) => c.id).join(",")]);
    for (const q of r.products ?? []) quotes.push(q);
  }
  return ids
    .map((p) => {
      const q = quotes.find((x) => x.productId === p.id);
      const days = (p.expiry - now) / DAY;
      const profit = Number(q?.profit ?? 0);
      return {
        productId: p.id, side, strike: p.strike, spot: px,
        distancePct: +(((p.strike - px) / px) * 100).toFixed(2),
        expiry: new Date(p.expiry).toISOString().slice(0, 16), days: +days.toFixed(1),
        termYieldPct: +(profit * 100).toFixed(3),
        annualisedPct: days > 0 ? +((profit * 365) / days * 100).toFixed(1) : null,
        canInvest: !!q?.canInvest && profit > 0,
        profit: q?.profit,
      };
    })
    .filter((r) => r.canInvest)
    .sort((a, b) => a.days - b.days || Math.abs(a.distancePct) - Math.abs(b.distancePct));
}

export async function dualInvest(productId, amount) {
  const p = parseId(productId);
  const q = cli(["earn", "dual", "prices", "--base", p.base, "--quote", p.quote, "--product-ids", productId]).products?.[0];
  if (!q?.canInvest || !(Number(q.profit) > 0)) throw new Error(`${productId} is not investable right now`);
  const px = await spotPrice(p.base);
  const notional = p.side === "buy" ? Number(amount) : Number(amount) * p.strike;
  const reasoning = `Dual ${p.side === "buy" ? "buy-low" : "sell-high"} ${p.base} @ ${p.strike} (spot ${px}) settling ${new Date(p.expiry).toISOString().slice(0, 10)}, paid ${(Number(q.profit) * 100).toFixed(3)}% for the term whether or not it fills.`;
  const pf = {
    action: p.side === "buy" ? "ADD" : "REDUCE", symbol: `${p.base}_USDT`,
    notional_usdt: +notional.toFixed(2), leverage: 1, confidence: "MEDIUM",
    sources: ["pionex-trade-cli earn dual prices"], reasoning,
  };
  try {
    execFileSync("node", ["lib/preflight.mjs", JSON.stringify(pf)], { cwd: ROOT, encoding: "utf8" });
  } catch (e) {
    throw new Error(`preflight REJECTED:\n${e.stdout ?? e.message}`);
  }
  const clientId = randomUUID().replace(/-/g, "").slice(0, 32);
  const args = ["earn", "dual", "invest", "--base", p.base, "--product-id", productId, "--client-dual-id", clientId, "--profit", q.profit];
  args.push(p.side === "buy" ? "--currency-amount" : "--base-amount", String(amount));
  const r = cli(args);
  logOrder({ action: pf.action, symbol: pf.symbol, type: "DUAL", side: p.side === "buy" ? "BUY" : "SELL", strike: p.strike, productId, amount: Number(amount), notional_usdt: pf.notional_usdt, termYield: Number(q.profit), clientDualId: clientId, result: "INVESTED", strategy: "dual", reasoning });
  return { productId, clientId, profit: q.profit, response: r };
}

export function dualPositions() {
  const bal = cli(["earn", "dual", "balances"]).balances ?? [];
  // get_invests needs the client ids, so read every one this project has ever placed.
  const ids = [];
  const dir = resolve(ROOT, "trades");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => /^d{4}-d{2}-d{2}.json$/.test(x))) {
      try {
        for (const o of JSON.parse(readFileSync(resolve(dir, f), "utf8")).orders ?? []) if (o.clientDualId) ids.push(o.clientDualId);
      } catch { /* unreadable day file */ }
    }
  }
  let invests = [];
  if (ids.length) {
    const d = cli(["earn", "dual", "get_invests", "--client-dual-ids", ids.join(",")]);
    invests = d.invests ?? d.orders ?? d.list ?? d;
  }
  return { balances: bal, invests };
}

/** Everything held in Earn, valued in USDT, for the snapshot. */
export async function earnValueUsdt() {
  let total = 0;
  const parts = [];
  for (const b of arbBalances()) {
    const v = Number(b.amount ?? b.balance ?? b.total ?? 0);
    if (v > 0) { total += v; parts.push({ kind: "earn-arb", coin: b.coin ?? "USDT", usdt: v }); }
  }
  for (const b of dualPositions().balances) {
    const coin = b.coin ?? b.currency ?? "USDT";
    const qty = Number(b.amount ?? b.balance ?? b.total ?? 0);
    if (!(qty > 0)) continue;
    const v = coin.startsWith("USD") ? qty : qty * (await spotPrice(coin));
    total += v;
    parts.push({ kind: "earn-dual", coin, usdt: v });
  }
  return { total, parts };
}

function logOrder(entry) {
  const day = new Date().toISOString().slice(0, 10);
  const p = resolve(ROOT, "trades", `${day}.json`);
  const doc = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { date: day, orders: [] };
  doc.orders = doc.orders ?? [];
  doc.orders.push({ ts: new Date().toISOString(), ...entry });
  writeFileSync(p, JSON.stringify(doc, null, 2));
}

// ---- CLI -----------------------------------------------------------------
if (process.argv[1]?.endsWith("earn.mjs")) {
  const [, , group, cmd, a, b] = process.argv;
  const maxDaysIdx = process.argv.indexOf("--max-days");
  const maxDays = maxDaysIdx > 0 ? Number(process.argv[maxDaysIdx + 1]) : 16;
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  const table = (rows) => {
    for (const r of rows) console.log(`  ${r.productId.padEnd(34)} ${String(r.distancePct + "%").padStart(7)}  ${String(r.days + "d").padStart(6)}  term ${String(r.termYieldPct + "%").padStart(7)}  ≈ ${String(r.annualisedPct + "%/yr").padStart(9)}`);
    if (!rows.length) console.log("  nothing investable in range");
  };
  const run = {
    "arb products": async () => out(arbProducts()),
    "arb balances": async () => out(arbBalances()),
    "arb stake": async () => out(arbMove("stake", a, b)),
    "arb unstake": async () => out(arbMove("unstake", a, b)),
    "dual scan": async () => table(await dualScan(a, b, maxDays)),
    "dual invest": async () => out(await dualInvest(a, b)),
    "dual positions": async () => out(dualPositions()),
    "value": async () => out(await earnValueUsdt()),
  }[`${group} ${cmd}`] ?? (group === "value" ? async () => out(await earnValueUsdt()) : null);
  if (!run) {
    console.error("usage: node lib/earn.mjs <arb products|balances|stake|unstake> | <dual scan BASE buy|sell|invest ID AMT|positions> | value");
    process.exit(2);
  }
  run().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
