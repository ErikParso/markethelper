#!/usr/bin/env node
/**
 * Benchmark scoring. Runs EVERY run, from inception, with no minimum age.
 *
 * WHY THIS EXISTS
 * ---------------
 * CLAUDE.md defined `/autotrade --score` as re-reading `trades/` OLDER THAN 30 DAYS.
 * The book was opened 2026-08-20, so that check could not execute even once, and
 * nobody noticed the result it would have produced: through run 10 the book was
 * +1.02% since inception while simply HOLDING BTC was +7.59% and holding cash was
 * 0.00%. A 6.5-point gap, invisible for ten runs, because the only instrument that
 * would have measured it was gated behind a date that had not arrived.
 *
 * A benchmark you cannot run is not a benchmark. This one takes a second and is
 * wired into lib/runcheck.mjs, so every run is scored whether it wants to be or not.
 *
 * The gap is diagnostic, not disqualifying. Losing to buy-and-hold BTC in a crypto
 * bull leg is expected for a diversified book; the question runcheck actually asks
 * is whether the trader has NOTICED and written down a response.
 *
 * Usage:
 *   node lib/score.mjs           # human-readable
 *   node lib/score.mjs --json    # machine-readable
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fb);

/** Inception = the earliest recorded order, plus the equity the book started with. */
export function inception(root = ROOT) {
  const dir = resolve(root, "trades");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) return null;

  let ts = Infinity, equity = null;
  for (const file of files) {
    const t = readJSON(join(dir, file));
    if (!t) continue;
    for (const o of t.orders ?? []) {
      const at = Date.parse(o.ts);
      if (Number.isFinite(at) && at < ts) ts = at;
    }
    if (equity === null && Number.isFinite(Number(t.equity_start_usdt))) equity = Number(t.equity_start_usdt);
  }
  return Number.isFinite(ts) && equity !== null ? { ts, equity } : null;
}

/** Hourly closes for a symbol, oldest first. Public endpoint, no auth. */
async function closes(symbol) {
  const r = await fetch(`https://api.pionex.com/api/v1/market/klines?symbol=${symbol}&interval=60M&limit=500`);
  const j = await r.json();
  if (!j?.data?.klines) throw new Error(`no klines for ${symbol}`);
  return j.data.klines.map((k) => ({ t: Number(k.time), c: Number(k.close) })).sort((a, b) => a.t - b.t);
}

/**
 * Score the book against the two benchmarks that matter: doing the obvious thing
 * (hold BTC) and doing nothing at all (hold cash).
 */
export async function score({ root = ROOT } = {}) {
  const inc = inception(root);
  const acct = readJSON(resolve(root, "state", "account.json"));
  if (!inc || !acct) return { ok: false, reason: "no inception record or no account state" };

  const equityNow = Number(acct.equity_usdt);
  const bookPct = ((equityNow - inc.equity) / inc.equity) * 100;

  let btcPct = null, btcFrom = null, btcTo = null;
  try {
    const k = await closes("BTC_USDT");
    // The bar covering inception; klines only reach back ~500h, so fall back to the
    // oldest available bar and say so rather than silently scoring a shorter window.
    const first = k.find((x) => x.t >= inc.ts - 3600_000) ?? k[0];
    const last = k[k.length - 1];
    btcFrom = first.c; btcTo = last.c;
    btcPct = ((last.c - first.c) / first.c) * 100;
  } catch { /* benchmark unavailable; reported as null rather than guessed */ }

  const truncated = btcFrom !== null && inc.ts < Date.now() - 500 * 3600_000;

  return {
    ok: true,
    since: new Date(inc.ts).toISOString(),
    equity_start: inc.equity,
    equity_now: equityNow,
    book_pct: bookPct,
    btc_pct: btcPct,
    btc_from: btcFrom,
    btc_to: btcTo,
    cash_pct: 0,
    gap_vs_btc: btcPct === null ? null : bookPct - btcPct,
    gap_vs_cash: bookPct,
    window_truncated: truncated,
  };
}

// ---- CLI -----------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const s = await score();
  if (!s.ok) { console.error(s.reason); process.exit(2); }
  if (process.argv.includes("--json")) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }
  const pct = (n) => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
  console.log(`SCORE since ${s.since}`);
  console.log(`  BOOK       ${s.equity_start.toFixed(2)} -> ${s.equity_now.toFixed(2)}   ${pct(s.book_pct)}`);
  console.log(`  HOLD BTC   ${s.btc_from ?? "?"} -> ${s.btc_to ?? "?"}   ${pct(s.btc_pct)}`);
  console.log(`  HOLD CASH  ${pct(0)}`);
  console.log(`\n  vs BTC  ${pct(s.gap_vs_btc)}    vs CASH  ${pct(s.gap_vs_cash)}`);
  if (s.window_truncated) console.log("\n  NOTE: inception predates the kline window; BTC leg is scored over a shorter period.");
}
