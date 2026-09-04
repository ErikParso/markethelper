#!/usr/bin/env node
/**
 * Score every ladder fill on HELD P&L — not on the bounce right after it filled.
 *
 * WHY THIS EXISTS
 * ---------------
 * For six runs I reported the resting-bid ladder as "4-for-4", and it was not a lie
 * exactly — every rung did fill below the prevailing market, and each was up shortly
 * afterwards. But that measured the wrong thing. Scored on where those positions
 * actually stand today, ALL FOUR FILLS WERE UNDERWATER (-1.22% on 48.40 USDT deployed).
 *
 * The metric flattered the mechanism because it was taken at the moment of maximum
 * favourability: a rung fills on a dip, so by construction it looks good minutes later.
 * Whether the trade MADE MONEY is a different question, and it is the only one that
 * matters. A ladder that buys every dip in a downtrend fills 100% of the time and
 * loses money on every one of them.
 *
 * So this is deliberately not a tool that can say "4-for-4". It reads the fills out of
 * trades/*.json, marks them against live prices, and prints held P&L per fill and in
 * total. If the ladder is working, this number is positive. If it is averaging down
 * into a downtrend, this number says so.
 *
 * Usage:  node lib/ladder-score.mjs [--json]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRADES = resolve(ROOT, "trades");

/** A ladder fill is an ADD placed as a LIMIT that the record shows actually filled. */
function collectFills() {
  if (!existsSync(TRADES)) return [];
  const files = readdirSync(TRADES).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const fills = [];
  for (const file of files) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(TRADES, file), "utf8"));
    } catch {
      continue;
    }
    for (const o of j.orders ?? []) {
      if (o.action !== "ADD" || o.type !== "LIMIT") continue;
      const result = String(o.result ?? "");
      // Only count orders the record says filled — RESTING/OPEN and CANCELLED do not count.
      if (!/FILLED/i.test(result)) continue;
      const px = Number(o.price);
      const usdt = Number(o.notional_usdt);
      if (!(px > 0) || !(usdt > 0)) continue;
      fills.push({ date: file.replace(".json", ""), run: o.run, symbol: o.symbol, price: px, usdt });
    }
  }
  return fills;
}

async function livePrices(symbols) {
  const px = {};
  try {
    const r = await fetch("https://api.pionex.com/api/v1/market/tickers", { signal: AbortSignal.timeout(15000) });
    const rows = (await r.json())?.data?.tickers ?? [];
    for (const row of rows) if (symbols.has(row.symbol)) px[row.symbol] = Number(row.close);
  } catch {
    /* leave empty rather than invent a price */
  }
  return px;
}

const fills = collectFills();
if (!fills.length) {
  console.log("LADDER SCORE — no recorded ladder fills yet.");
  process.exit(0);
}

const px = await livePrices(new Set(fills.map((f) => f.symbol)));
let totalPnl = 0;
let totalInvested = 0;
let winners = 0;
const rows = [];

for (const f of fills) {
  const now = px[f.symbol];
  if (!now) {
    rows.push({ ...f, now: null, pct: null, pnl: null });
    continue;
  }
  const pct = ((now - f.price) / f.price) * 100;
  const pnl = (f.usdt * pct) / 100;
  totalPnl += pnl;
  totalInvested += f.usdt;
  if (pnl > 0) winners++;
  rows.push({ ...f, now, pct, pnl });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ fills: rows, totalInvested, totalPnl, winners, count: rows.length }, null, 2));
  process.exit(0);
}

const n = (v, w, d = 2) => (v === null ? "n/a".padStart(w) : v.toFixed(d).padStart(w));
console.log("LADDER SCORE — held P&L, marked to live prices");
console.log("  (NOT the bounce after the fill. That metric said 4-for-4 while every fill was underwater.)\n");
for (const r of rows) {
  console.log(
    `  ${r.date}  run ${String(r.run).padEnd(4)} ${r.symbol.replace("_USDT", "").padEnd(5)} @ ${String(r.price).padStart(8)}` +
      `  ${n(r.usdt, 6)} USDT   now ${n(r.pct, 7)}%   pnl ${n(r.pnl, 6)}`,
  );
}
const pctTotal = totalInvested ? (totalPnl / totalInvested) * 100 : 0;
console.log(`\n  ${rows.length} fills, ${totalInvested.toFixed(2)} USDT deployed`);
console.log(`  HELD P&L  ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT  (${pctTotal >= 0 ? "+" : ""}${pctTotal.toFixed(2)}%)`);
console.log(`  profitable fills: ${winners}/${rows.length}`);
if (totalPnl < 0) {
  console.log("\n  ⚠ The ladder is currently LOSING money. Filling reliably is not the same as being right:");
  console.log("    a bid below the market fills 100% of the time in a downtrend, and loses on every fill.");
  console.log("    Do not report fill-rate as if it were performance.");
}
