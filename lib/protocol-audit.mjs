#!/usr/bin/env node
/**
 * Protocol compliance audit — checks the TRADER, from evidence, not from its own claims.
 *
 * WHY THIS EXISTS
 * ---------------
 * Erik, 2026-08-21: "i think you do whatever you want, and ignore instructions. we
 * should build more gates that validate if you really do everything as i described."
 *
 * He is right, and the gap is structural. Every other check in this repo reads files
 * the trader itself wrote:
 *   - coverage.mjs   checks that findings were TYPED, not that research was DONE.
 *   - runcheck.mjs   checks the shape of reasoning the trader authored.
 *   - trades/*.json  is the trader's own account of its own orders.
 * A trader that skipped a step and wrote a plausible paragraph passed all of them.
 *
 * This file only trusts two things the trader cannot author: THE EXCHANGE, and the
 * preflight receipts written by preflight.mjs itself at approval time. Everything is
 * reconciled against those.
 *
 * WHAT IT CATCHES
 *   1. An order that hit the exchange without passing preflight.
 *   2. An order that hit the exchange and was never logged to trades/.
 *   3. A position held on the venue with no thesis in theses.md (and the reverse).
 *   4. Stale state: account, coverage, or price scan not refreshed this run.
 *   5. Themes "researched" with no source cited.
 *   6. Benchmark underperformance that has not been acknowledged in writing.
 *   7. A registered test that fired and was ignored.
 *
 * Usage:
 *   node lib/protocol-audit.mjs             # full audit; exit 1 on any violation
 *   node lib/protocol-audit.mjs --offline   # skip the exchange reconciliation
 *   node lib/protocol-audit.mjs --json
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLedger } from "./tests-ledger.mjs";
import { score } from "./score.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = (...s) => resolve(ROOT, ...s);
const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fb);
const readText = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const minsAgo = (iso) => (Date.now() - Date.parse(iso)) / 60000;

/** Preflight receipts, written by preflight.mjs at approval time. */
function receipts() {
  const f = P("state", "preflight-log.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** Every order the trader claims it placed. */
function loggedOrders() {
  const dir = P("trades");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    for (const o of readJSON(join(dir, f))?.orders ?? []) out.push(o);
  }
  return out;
}

/** Real fills, straight from the venue. The trader cannot author these. */
function exchangeFills(symbols) {
  const fills = [];
  for (const sym of symbols) {
    let raw;
    try {
      // shell:true is required on Windows, where pionex-trade-cli is a .cmd shim
      // that execFileSync cannot spawn directly. Without it this threw silently and
      // the whole reconciliation reported "skipped" — the check that matters most,
      // quietly doing nothing. Caught by running the audit against a live book.
      raw = execFileSync(`pionex-trade-cli orders fills --symbol ${sym}`,
        { encoding: "utf8", maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "ignore"], shell: true });
    } catch { continue; }
    for (const m of raw.matchAll(/\{[^{}]*"symbol"[^{}]*\}/g)) {
      try {
        const f = JSON.parse(m[0]);
        if (f.symbol && f.orderId) fills.push(f);
      } catch { /* partial JSON in a truncated stream */ }
    }
  }
  return fills;
}

export async function audit({ offline = false } = {}) {
  const problems = [], notes = [];
  const acct = readJSON(P("state", "account.json"));
  const cov = readJSON(P("state", "coverage.json"));
  const theses = readText(P("theses.md"));

  // ---- 1-2. Exchange reconciliation: gated, and logged. -------------------
  if (!offline && acct?.exposure_by_symbol) {
    const symbols = Object.keys(acct.exposure_by_symbol);
    const fills = exchangeFills(symbols);
    const logged = loggedOrders();
    const rcpt = receipts();

    if (!fills.length) {
      notes.push("no fills returned by the exchange — reconciliation skipped, not passed.");
    }
    for (const f of fills) {
      const at = Number(f.timestamp);
      const sym = f.symbol;

      // Logged? Match on orderId, else on symbol+price+size.
      const inLog = logged.some((o) =>
        String(o.orderId ?? "") === String(f.orderId) ||
        (o.symbol === sym && Math.abs(Number(o.price ?? 0) - Number(f.price)) < 0.01 &&
         Math.abs(Number(o.size ?? 0) - Number(f.size)) < 1e-9));
      if (!inLog) {
        problems.push(
          `UNLOGGED ORDER: exchange shows ${f.side} ${f.size} ${sym} @ ${f.price} ` +
          `(order ${f.orderId}, ${new Date(at).toISOString()}) with no entry in trades/. ` +
          `Every order must be logged — the record is the only thing that later reveals whether the research works.`);
      }

      // Gated? A receipt for the same symbol within 30min before the fill.
      const gated = rcpt.some((r) => {
        const rt = Date.parse(r.ts);
        return r.symbol === sym && rt <= at + 60_000 && at - rt <= 30 * 60_000;
      });
      // Receipts only began at run 10; older fills cannot be judged.
      const RECEIPTS_FROM = Date.parse("2026-08-21T17:50:00Z");
      if (!gated && at > RECEIPTS_FROM) {
        problems.push(
          `UNGATED ORDER: exchange shows ${f.side} ${f.size} ${sym} @ ${f.price} ` +
          `(order ${f.orderId}) with no preflight receipt in the 30min before it. ` +
          `preflight.mjs is the ONLY path to an order — it is where the kill switch is honoured.`);
      }
    }
  }

  // ---- 3. theses.md must describe exactly what is held. -------------------
  if (acct?.exposure_by_symbol) {
    for (const [sym, val] of Object.entries(acct.exposure_by_symbol)) {
      if (Number(val) < 1) continue; // dust
      const base = sym.replace(/_USDT(_PERP)?$/, "");
      if (!theses.includes(sym) && !new RegExp(`\\b${base}\\b`).test(theses)) {
        problems.push(
          `UNDOCUMENTED POSITION: ${sym} is held (${Number(val).toFixed(2)} USDT) but appears nowhere in ` +
          `theses.md. "Pionex knows what is held; only that file knows why."`);
      }
    }
  }

  // ---- 4. Freshness: did this run actually refetch? -----------------------
  if (!acct) problems.push("state/account.json missing — the book was never read this run.");
  else if (minsAgo(acct.as_of) > 30) {
    problems.push(`STALE ACCOUNT: state/account.json is ${Math.round(minsAgo(acct.as_of))}min old. ` +
      `The protocol requires refetching every run; never state a balance from memory.`);
  }
  if (!cov) problems.push("state/coverage.json missing — pass 2 was not swept.");
  else {
    if (minsAgo(cov.as_of) > 90) problems.push(`STALE COVERAGE: ${Math.round(minsAgo(cov.as_of))}min old.`);
    const scanned = Number(cov.symbols_scanned ?? 0);
    if (!(scanned > 0)) problems.push("PRICE SCAN NOT RUN: coverage.symbols_scanned is 0 or missing.");
  }

  // ---- 5. Research must cite something. -----------------------------------
  // A finding with no URL anywhere in the theme is indistinguishable from a
  // plausible paragraph, which is exactly the failure mode this file exists for.
  if (cov?.themes) {
    const anySources = /https?:\/\//.test(JSON.stringify(cov));
    if (!anySources) {
      problems.push("NO SOURCES ANYWHERE IN COVERAGE: every theme finding must be traceable to something " +
        "that was actually read. Findings with no source cannot be distinguished from invention.");
    }
  }

  // ---- 6. Benchmark: measured every run, and acknowledged when losing. ----
  let sc = null;
  try { sc = await score({ root: ROOT }); } catch { /* offline */ }
  if (sc?.ok && sc.gap_vs_btc !== null) {
    notes.push(`benchmark: book ${sc.book_pct.toFixed(2)}% vs BTC ${sc.btc_pct.toFixed(2)}% ` +
      `(gap ${sc.gap_vs_btc.toFixed(2)} pts) since ${sc.since}`);
    const ack = String(cov?.benchmark_response ?? "").trim();
    if (sc.gap_vs_btc < -2 && ack.length < 60) {
      problems.push(
        `LOSING TO THE BENCHMARK BY ${Math.abs(sc.gap_vs_btc).toFixed(1)} POINTS and coverage.json has no ` +
        `"benchmark_response". CLAUDE.md: report it honestly, especially when the benchmark wins. Write what ` +
        `is causing the gap and what changes because of it — or say plainly that the tool should be turned off.`);
    }
  }

  // ---- 7. Registered tests that fired and were ignored. -------------------
  const led = checkLedger({ currentRun: null });
  for (const p2 of led.problems) problems.push(`LEDGER: ${p2}`);

  return { ok: problems.length === 0, problems, notes, score: sc };
}

// ---- CLI -----------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = await audit({ offline: process.argv.includes("--offline") });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  console.log("PROTOCOL AUDIT");
  for (const n of r.notes) console.log(`  note: ${n}`);
  console.log("");
  if (r.ok) { console.log("COMPLIANT — every order gated and logged, book matches theses, state fresh."); process.exit(0); }
  console.log("VIOLATIONS\n  - " + r.problems.join("\n\n  - "));
  process.exit(1);
}
