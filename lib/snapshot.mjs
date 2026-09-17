#!/usr/bin/env node
/**
 * Write state/account.json — the book's true position across EVERY wallet.
 *
 * WHY THIS EXISTS
 * ---------------
 * Twice now a snapshot has read one wallet and silently misreported the book. First it
 * read SPOT only: the moment 48 USDT went into a grid bot, equity "fell" from 147 to 99.
 * Then the strategy started using perps, whose margin and P&L live in a THIRD wallet
 * (futures / TRADE) that `wallet balance_full` may or may not count. So equity is now
 * built from the parts — spot, bots, futures margin, perp unrealized P&L — and compared
 * against the venue's own total. A disagreement is printed, never averaged away.
 *
 * Open orders are read for every coin actually held, not a hard-coded pair, because the
 * book now keeps resting orders working between runs.
 *
 * Usage: node lib/snapshot.mjs [--json]      (set RUN=<n> to stamp the run number)
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { positions as perpPositions, balances as perpBalances, openOrders as perpOpenOrders } from "./perp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = "pionx-prod";

const cli = (args) =>
  JSON.parse(execFileSync("pionex-trade-cli", ["--profile", PROFILE, ...args], { encoding: "utf8", shell: true }));

const wallet = cli(["wallet", "balance_full"]);
const data = wallet.data;
const venueTotal = Number(data.totalInUsdt);

const tickers = await fetch("https://api.pionex.com/api/v1/market/tickers").then((r) => r.json());
const px = Object.fromEntries(tickers.data.tickers.map((t) => [t.symbol, Number(t.close)]));
px.USDT_USDT = 1;

const details = data.botAccount?.detail ?? [];
const spot = details.find((d) => d.type === "spot");
const bots = details.filter((d) => d.type === "trading_bot");

const positions = [];
let freeCash = 0;
let spotTotal = 0;

for (const row of spot?.list ?? []) {
  const qty = Number(row.assets);
  if (!(qty > 0)) continue;
  const coin = row.coin;
  const price = coin === "USDT" ? 1 : px[coin + "_USDT"];
  if (!price) continue;
  const usdt = qty * price;
  spotTotal += usdt;
  if (usdt < 0.01) continue; // dust: real but not a position
  if (coin === "USDT") freeCash = Number(row.free);
  positions.push({ kind: "spot", coin, qty, price, usdt: +usdt.toFixed(4) });
}

let botTotal = 0;
for (const b of bots) {
  const usdt = Number(b.totalInUsdt);
  if (!(usdt > 0)) continue;
  botTotal += usdt;
  positions.push({ kind: "bot", coin: b.title || "Trading bot", qty: null, price: null, usdt: +usdt.toFixed(4) });
}

// ---- futures wallet: free margin, isolated margin, open perp positions -------
const num = (o, keys) => { for (const k of keys) if (o?.[k] != null && Number.isFinite(Number(o[k]))) return Number(o[k]); return 0; };
const fb = await perpBalances();
let futuresFree = 0;
for (const b of fb.balances ?? []) if (b.coin === "USDT") futuresFree += num(b, ["free"]) + num(b, ["frozen"]);
let isolatedMargin = 0;
for (const i of fb.isolates ?? []) isolatedMargin += num(i, ["isolatedMargin", "margin", "balance", "positionMargin"]);

const perps = await perpPositions();
let unrealized = 0;
for (const p of perps) {
  const net = Number(p.netSize);
  const mark = px[p.symbol] ?? Number(p.markPrice ?? p.avgPrice);
  const upnl = num(p, ["unrealizedPnL", "unrealizedPnl", "unrealizedProfit"]);
  unrealized += upnl;
  // If the venue did not report isolated margin separately, fall back to the position's.
  if (!(fb.isolates ?? []).length) isolatedMargin += num(p, ["initialMargin", "isolatedMargin", "margin"]);
  positions.push({
    kind: "perp", coin: p.symbol, qty: net, price: mark, side: net < 0 ? "SHORT" : "LONG",
    usdt: +Math.abs(net * mark).toFixed(4), unrealizedPnL: +upnl.toFixed(4),
    liquidationPrice: Number(p.liquidationPrice) || null, leverage: p.leverage,
  });
}
const futuresTotal = futuresFree + isolatedMargin + unrealized;

// Built from the parts. Perp notional is NOT added — only the margin and P&L are equity.
const equity = spotTotal + botTotal + futuresTotal;
if (!(equity > 0)) throw new Error("could not compute equity from wallets");
const venueGap = venueTotal > 0 ? (venueTotal - equity) / equity : 0;

for (const p of positions) p.pct = +((p.usdt / equity) * 100).toFixed(2);
positions.sort((a, b) => b.usdt - a.usdt);

// Open orders on every coin held (plus BTC/ETH), spot and perp.
const coins = new Set(["BTC", "ETH", ...positions.filter((p) => p.kind === "spot" && p.coin !== "USDT").map((p) => p.coin)]);
const openOrders = [];
for (const c of coins) {
  try {
    const o = cli(["orders", "open", "--symbol", `${c}_USDT`]);
    for (const ord of o.data?.orders ?? []) {
      openOrders.push({ market: "spot", symbol: ord.symbol, side: ord.side, price: Number(ord.price), size: Number(ord.size), orderId: ord.orderId });
    }
  } catch { /* no book for this coin */ }
}
for (const ord of await perpOpenOrders()) {
  openOrders.push({ market: "perp", symbol: ord.symbol, side: ord.side, price: Number(ord.price), size: Number(ord.size), orderId: ord.orderId });
}

const prev = existsSync(resolve(ROOT, "state/account.json"))
  ? JSON.parse(readFileSync(resolve(ROOT, "state/account.json"), "utf8"))
  : {};
const now = new Date().toISOString();
const out = {
  as_of: now,
  ts: now,
  run: Number(process.env.RUN) || prev.run || 0,
  equity_usdt: +equity.toFixed(4),
  venue_total_usdt: +venueTotal.toFixed(4),
  venue_gap_pct: +(venueGap * 100).toFixed(2),
  cash_usdt: +freeCash.toFixed(4),
  bot_capital_usdt: +botTotal.toFixed(4),
  futures: { free_usdt: +futuresFree.toFixed(4), isolated_margin_usdt: +isolatedMargin.toFixed(4), unrealized_pnl_usdt: +unrealized.toFixed(4), total_usdt: +futuresTotal.toFixed(4) },
  positions,
  open_orders: openOrders,
};
writeFileSync(resolve(ROOT, "state/account.json"), JSON.stringify(out, null, 2));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`EQUITY ${out.equity_usdt}  (spot cash ${out.cash_usdt} · bots ${out.bot_capital_usdt} · futures ${out.futures.total_usdt})`);
  if (Math.abs(venueGap) > 0.02) {
    console.log(`  ⚠ venue reports ${venueTotal.toFixed(2)} — ${out.venue_gap_pct}% off the computed total. Check which wallet one of them is missing.`);
  }
  for (const p of positions) {
    const extra = p.kind === "perp" ? `  ${p.side} uPnL ${p.unrealizedPnL} liq ${p.liquidationPrice ?? "?"} ${p.leverage ?? "?"}x` : "";
    console.log(`  ${String(p.kind).padEnd(4)} ${String(p.coin).padEnd(16)} ${String(p.usdt).padStart(9)}  ${p.pct}%${extra}`);
  }
  console.log(`  working orders: ${openOrders.length}${openOrders.length ? "" : "  ⚠ NONE — the book cannot trade until the next run"}`);
  for (const o of openOrders) console.log(`    ${o.market} ${o.symbol} ${o.side} ${o.size} @ ${o.price}`);
}
