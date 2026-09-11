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
/**
 * BTC close covering the book's inception (2026-08-20T11:15Z), pinned because the
 * kline feed only reaches back ~500 hours. Recorded from the feed itself while the
 * window still covered it, and reported consistently across runs 30-65 as the
 * "HOLD BTC 71927.07 -> ..." start. Do NOT recompute this from klines.
 */
const BTC_AT_INCEPTION = 71927.07;

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

  let btcPct = null, btcFrom = null, btcTo = null, anchored = false;
  try {
    const k = await closes("BTC_USDT");
    // Klines only reach back ~500h. Once inception falls outside that window the
    // fallback below silently rebased the benchmark to a much later, much lower
    // start — on 2026-09-11 it used 77,384 instead of the real 71,927 and reported
    // the gap as -1.76 points when the truth was about -9.3. A benchmark that
    // flatters itself as the window rolls is worse than no benchmark, so the
    // inception price is pinned here and used whenever the window cannot reach it.
    // The bar must actually COVER inception. A plain ">= inception" match happily
    // returns the oldest bar in the window even when that bar is weeks too late,
    // which is precisely how the benchmark silently rebased itself.
    const first = k.find((x) => x.t >= inc.ts - 3600_000 && x.t <= inc.ts + 6 * 3600_000);
    const last = k[k.length - 1];
    btcTo = last.c;
    if (first) {
      btcFrom = first.c;
    } else {
      btcFrom = BTC_AT_INCEPTION;
      anchored = true;
    }
    btcPct = ((btcTo - btcFrom) / btcFrom) * 100;
  } catch { /* benchmark unavailable; reported as null rather than guessed */ }

  // Only a genuine loss of the anchor counts as truncation now.
  const truncated = btcFrom !== null && anchored && !Number.isFinite(BTC_AT_INCEPTION);

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

/**
 * SECOND WINDOW: performance since the book FIRST OWNED BTC.
 *
 * WHY. Measured from inception the book trails HOLD BTC by ~8.8 points — but 8.43 of
 * those points accrued in the first 24 hours, BEFORE a single sat was owned: day one put
 * half the book into USOX (oil), closed it at a loss, and BTC was not bought until run 8,
 * by which time it had already run +8.43%.
 *
 * That is a SUNK, FIXED debt. It cannot be closed by trading better today, and treating it
 * as a live indictment actively distorts decisions — it is precisely what tempts a trader
 * to chase BTC at highs to "catch up". The inception number stays (it is the honest
 * lifetime record and it is what Erik is owed), but this second line measures the thing
 * that is actually still controllable: the process from the moment the book was positioned.
 *
 * Anchored at the first BTC BUY order, using the equity of the nearest run decision at or
 * after it. Returns null rather than guessing if either anchor is missing.
 */
export async function scoreSinceBtcOwned(root = ROOT) {
  const dir = resolve(root, "trades");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  let anchorTs = null, anchorBtcPx = null;
  const equityPoints = [];
  for (const file of files) {
    const j = readJSON(join(dir, file));
    if (!j) continue;
    for (const o of j.orders ?? []) {
      const ts = Date.parse(o.ts);
      if (Number.isNaN(ts)) continue;
      if (anchorTs === null && o.symbol === "BTC_USDT" && o.side === "BUY" && Number(o.price) > 0) {
        anchorTs = ts;
        anchorBtcPx = Number(o.price);
      }
    }
    for (const [k, v] of Object.entries(j)) {
      if (!k.endsWith("_decision") || !v?.equity_usdt) continue;
      const ts = Date.parse(v.ts);
      if (!Number.isNaN(ts)) equityPoints.push({ ts, equity: Number(v.equity_usdt) });
    }
  }
  if (anchorTs === null || !equityPoints.length) return null;

  equityPoints.sort((a, b) => a.ts - b.ts);
  const start = equityPoints.find((p) => p.ts >= anchorTs);
  const end = equityPoints[equityPoints.length - 1];
  if (!start || !end || start.ts === end.ts) return null;

  const acct = readJSON(resolve(root, "state/account.json"));
  const equityNow = Number(acct?.equity_usdt) || end.equity;

  let btcNow = null;
  try {
    const r = await fetch("https://api.pionex.com/api/v1/market/tickers?symbol=BTC_USDT", { signal: AbortSignal.timeout(15000) });
    btcNow = Number((await r.json())?.data?.tickers?.[0]?.close) || null;
  } catch { /* leave null rather than invent a price */ }

  const bookPct = ((equityNow - start.equity) / start.equity) * 100;
  const btcPct = btcNow === null ? null : ((btcNow - anchorBtcPx) / anchorBtcPx) * 100;
  return {
    since: new Date(anchorTs).toISOString(),
    equity_start: start.equity,
    equity_now: equityNow,
    book_pct: bookPct,
    btc_from: anchorBtcPx,
    btc_to: btcNow,
    btc_pct: btcPct,
    gap_vs_btc: btcPct === null ? null : bookPct - btcPct,
  };
}

// ---- CLI -----------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const s = await score();
  if (!s.ok) { console.error(s.reason); process.exit(2); }
  if (process.argv.includes("--json")) {
    const owned = await scoreSinceBtcOwned();
    console.log(JSON.stringify({ ...s, since_btc_owned: owned }, null, 2));
    process.exit(0);
  }
  const pct = (n) => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
  console.log(`SCORE since ${s.since}`);
  console.log(`  BOOK       ${s.equity_start.toFixed(2)} -> ${s.equity_now.toFixed(2)}   ${pct(s.book_pct)}`);
  console.log(`  HOLD BTC   ${s.btc_from ?? "?"} -> ${s.btc_to ?? "?"}   ${pct(s.btc_pct)}`);
  console.log(`  HOLD CASH  ${pct(0)}`);
  console.log(`\n  vs BTC  ${pct(s.gap_vs_btc)}    vs CASH  ${pct(s.gap_vs_cash)}`);
  if (s.window_truncated) console.log("\n  NOTE: inception predates the kline window; BTC leg is scored over a shorter period.");

  const owned = await scoreSinceBtcOwned();
  if (owned) {
    console.log(`\nSINCE THE BOOK FIRST OWNED BTC (${owned.since.slice(0, 16)}Z)`);
    console.log(`  BOOK       ${owned.equity_start.toFixed(2)} -> ${owned.equity_now.toFixed(2)}   ${pct(owned.book_pct)}`);
    console.log(`  HOLD BTC   ${owned.btc_from} -> ${owned.btc_to ?? "?"}   ${pct(owned.btc_pct)}`);
    console.log(`\n  vs BTC  ${pct(owned.gap_vs_btc)}`);
    console.log(`  Most of the lifetime gap is a SUNK day-one debt (oil trade, BTC bought a day late).`);
    console.log(`  This line is the part still under the trader's control. Do NOT chase the other one.`);
  }
}
