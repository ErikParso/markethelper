#!/usr/bin/env node
/**
 * Write state/account.json — the book's true position, including bot capital.
 *
 * WHY THIS EXISTS
 * ---------------
 * For 67 runs the snapshot read only the SPOT list. That was fine while everything
 * sat in spot, and silently wrong the moment capital moved into a trading bot: the
 * first grid bot took 48 USDT and equity appeared to drop from 147 to 99. Every
 * number downstream — score, benchmark gap, position weights — would have inherited
 * that error, in a project whose worst recurring defect is measurements that quietly
 * misreport themselves.
 *
 * So this reads `data.totalInUsdt`, the venue's own authoritative total, and treats
 * bot capital as a first-class position rather than something outside the book.
 *
 * Usage: node lib/snapshot.mjs [--json]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = "pionx-prod";

const cli = (args) =>
  JSON.parse(execFileSync("pionex-trade-cli", ["--profile", PROFILE, ...args], { encoding: "utf8", shell: true }));

const wallet = cli(["wallet", "balance_full"]);
const data = wallet.data;

// The venue's own total. Never recompute this from a subset of accounts.
const equity = Number(data.totalInUsdt);
if (!(equity > 0)) throw new Error("wallet returned no usable totalInUsdt");

const tickers = await fetch("https://api.pionex.com/api/v1/market/tickers").then((r) => r.json());
const px = Object.fromEntries(tickers.data.tickers.map((t) => [t.symbol, Number(t.close)]));
px.USDT_USDT = 1;

const details = data.botAccount?.detail ?? [];
const spot = details.find((d) => d.type === "spot");
const bots = details.filter((d) => d.type === "trading_bot");

const positions = [];
let freeCash = 0;

for (const row of spot?.list ?? []) {
  const qty = Number(row.assets);
  if (!(qty > 0)) continue;
  const coin = row.coin;
  const price = coin === "USDT" ? 1 : px[coin + "_USDT"];
  if (!price) continue;
  const usdt = qty * price;
  if (usdt < 0.01) continue; // dust: real but not a position
  if (coin === "USDT") freeCash = Number(row.free);
  positions.push({ kind: "spot", coin, qty, price, usdt: +usdt.toFixed(4) });
}

// Bot capital is working capital, not a rounding error. Carry it explicitly.
let botTotal = 0;
for (const b of bots) {
  const usdt = Number(b.totalInUsdt);
  if (!(usdt > 0)) continue;
  botTotal += usdt;
  positions.push({ kind: "bot", coin: b.title || "Trading bot", qty: null, price: null, usdt: +usdt.toFixed(4) });
}

for (const p of positions) p.pct = +((p.usdt / equity) * 100).toFixed(2);
positions.sort((a, b) => b.usdt - a.usdt);

// Grid bots hold their own orders; only loose spot orders are listed here.
const openOrders = [];
for (const sym of ["BTC_USDT", "ETH_USDT"]) {
  try {
    const o = cli(["orders", "open", "--symbol", sym]);
    for (const ord of o.data?.orders ?? []) {
      openOrders.push({ symbol: ord.symbol, side: ord.side, price: Number(ord.price), size: Number(ord.size), orderId: ord.orderId });
    }
  } catch { /* a symbol with no book is not an error */ }
}

const prev = existsSync(resolve(ROOT, "state/account.json"))
  ? JSON.parse(readFileSync(resolve(ROOT, "state/account.json"), "utf8"))
  : {};
const now = new Date().toISOString();
const out = {
  as_of: now,
  ts: now,
  run: Number(process.env.RUN ?? prev.run ?? 0) || prev.run || 0,
  equity_usdt: +equity.toFixed(4),
  cash_usdt: +freeCash.toFixed(4),
  bot_capital_usdt: +botTotal.toFixed(4),
  positions,
  open_orders: openOrders,
};
writeFileSync(resolve(ROOT, "state/account.json"), JSON.stringify(out, null, 2));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`EQUITY ${out.equity_usdt}  (free cash ${out.cash_usdt}, in bots ${out.bot_capital_usdt})`);
  for (const p of positions) {
    console.log(`  ${String(p.kind).padEnd(4)} ${String(p.coin).padEnd(13)} ${String(p.usdt).padStart(9)}  ${p.pct}%`);
  }
  console.log(`  loose open orders: ${openOrders.length}`);
}
