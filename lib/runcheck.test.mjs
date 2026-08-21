#!/usr/bin/env node
/**
 * Tests for lib/runcheck.mjs, run against throwaway fixture directories so the
 * live book is never touched.
 *
 * The important test is REGRESSION_RUN_10: it reconstructs the state run 10
 * actually ended in on its first pass — 8/8 PASS themes, the correlation and
 * anticorrelation vetoes both used, cash at 0.70 against a 10 USDT minimum, and a
 * third consecutive no-trade decision — and asserts the gate fires on all of it.
 * That run shipped as "no trades" and Erik had to catch it by hand. This is the
 * proof it cannot ship silently again.
 *
 * Usage: node lib/runcheck.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRun, noTradeStreak, decisionHistory } from "./runcheck.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "\n         " + detail : ""}`); }
};

/** Build a disposable repo-shaped fixture. */
function fixture({ themes = {}, cash = 50, decisions = [], coverageExtra = {} }) {
  const root = mkdtempSync(join(tmpdir(), "runcheck-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "trades"), { recursive: true });
  writeFileSync(join(root, "policy.json"), JSON.stringify({ capital: { min_notional_usdt: 10 } }));
  writeFileSync(join(root, "state", "account.json"), JSON.stringify({ cash_usdt: cash }));
  writeFileSync(join(root, "state", "coverage.json"), JSON.stringify({ themes, ...coverageExtra }));
  const log = { date: "2026-08-21", orders: [] };
  for (const d of decisions) log[`run${d.run}_decision`] = { action: d.action };
  writeFileSync(join(root, "trades", "2026-08-21.json"), JSON.stringify(log));
  return root;
}

const has = (problems, needle) => problems.some((x) => x.includes(needle));
const cleanup = (r) => rmSync(r, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log("\nruncheck.mjs\n");

// --- 1. The closed loop, which is the whole reason this file exists ---------
{
  const root = fixture({
    themes: {
      semis: { verdict: "PASS", why_passed: "It is the same view the book already holds." },
      tsla: { verdict: "PASS", why_passed: "Buying it would be a hedge against my own thesis." },
    },
  });
  const { ok: clean, problems } = auditRun({ root });
  ok("detects correlated + anticorrelated vetoes used together", !clean && has(problems, "CLOSED LOOP"));
  cleanup(root);
}

// --- 2. One veto alone is legitimate and must NOT fire ---------------------
{
  const root = fixture({
    themes: { semis: { verdict: "PASS", why_passed: "It is the same view the book already holds." } },
  });
  const { problems } = auditRun({ root });
  ok("correlation veto ALONE does not trip the closed-loop check", !has(problems, "CLOSED LOOP"));
  cleanup(root);
}

// --- 3. Correction provenance must not be mistaken for live reasoning ------
{
  const root = fixture({
    themes: {
      semis: { verdict: "PASS", why_passed: "Rejected on the NVDA earnings binary in 5 days and perp liquidation risk. ⚠ CORRECTED run 10: originally said this was the same view the book already holds, which was half a closed loop." },
      tsla: { verdict: "PASS", why_passed: "Priced in: +5.95% today on the exact catalysts. ⚠ CORRECTED run 10: originally said it would be a hedge against my own thesis." },
    },
  });
  const { problems } = auditRun({ root });
  ok("text after a CORRECTED marker is provenance, not a live veto", !has(problems, "CLOSED LOOP"));
  cleanup(root);
}

// --- 4. "Priced in" with no number is a mood, not a reason -----------------
{
  const root = fixture({ themes: { oil: { verdict: "PASS", why_passed: "The market has already priced in the whole story." } } });
  ok("flags an unquantified priced-in rejection", has(auditRun({ root }).problems, "no number"));
  cleanup(root);
}
{
  const root = fixture({ themes: { oil: { verdict: "PASS", why_passed: "Priced in: Brent 92.68 against the EIA 3Q26 forecast of 85." } } });
  ok("accepts a quantified priced-in rejection", !has(auditRun({ root }).problems, "no number"));
  cleanup(root);
}

// --- 5. The cash trap that made runs 9 and 10 unable to act ---------------
{
  const root = fixture({ cash: 0.7 });
  ok("flags cash below one venue minimum", has(auditRun({ root }).problems, "CASH TRAP"));
  cleanup(root);
}
{
  const root = fixture({
    cash: 0.7,
    coverageExtra: { full_deployment_is_deliberate: "Deliberate: the book is fully deployed into three conviction positions and a forced sale is one market order away at ~0.1%." },
  });
  ok("accepts a declared, deliberate full deployment", !has(auditRun({ root }).problems, "CASH TRAP"));
  cleanup(root);
}

// --- 6. Streak forces a falsifiable hold and a real ranking ---------------
{
  const decisions = [{ run: 8, action: "NO TRADES" }, { run: 9, action: "NO TRADES" }];
  const root = fixture({ decisions });
  const { problems } = auditRun({ root });
  ok("streak demands what_would_have_flipped_it", has(problems, "what_would_have_flipped_it"));
  ok("streak demands ranked_candidates", has(problems, "ranked_candidates"));
  cleanup(root);
}
{
  const root = fixture({
    decisions: [{ run: 8, action: "NO TRADES" }, { run: 9, action: "NO TRADES" }],
    coverageExtra: {
      what_would_have_flipped_it: "Brent below 85, at or under the EIA 3Q26 forecast rather than 9 percent above it.",
      ranked_candidates: [{ rank: 1, idea: "short semis" }, { rank: 2, idea: "long brent" }],
    },
  });
  const { problems } = auditRun({ root });
  ok("satisfied streak passes", !has(problems, "what_would_have_flipped_it") && !has(problems, "ranked_candidates"));
  cleanup(root);
}

// --- 7. A run that traded resets the streak ------------------------------
{
  const root = fixture({ decisions: [{ run: 8, action: "NO TRADES" }, { run: 9, action: "TRADED. Bought 20 USDT of BTC." }] });
  ok("a TRADED decision resets the streak", noTradeStreak(decisionHistory(root)) === 0);
  cleanup(root);
}

// --- 8. REGRESSION: run 10's actual first-pass state must not be clean ----
{
  const root = fixture({
    cash: 0.6998961583146265,
    decisions: [
      { run: 6, action: "NO TRADES - hold PAXG and SLVX" },
      { run: 7, action: "NO TRADES - hold PAXG and SLVX" },
      { run: 8, action: "TRADED. Bought 20 USDT of BTC with idle cash." },
      { run: 9, action: "NO TRADES. Hold PAXG, SLVX and BTC." },
      { run: 10, action: "NO TRADES" },
    ],
    themes: {
      ai_bigtech: { verdict: "PASS", why_passed: "DECISIVE: it is the SAME VIEW the book already holds. Shorting semis would take correlated single-view exposure past 100%." },
      space_futuretech: { verdict: "PASS", why_passed: "Buying it would be a hedge against my own thesis, which is not a reason to own something." },
      anchors_metals: { verdict: "PASS", why_passed: "Broad equity beta is the wrong side of this book's own thesis. No reason to pay a spread to own both sides." },
      crypto_fintech: { verdict: "PASS", why_passed: "A fourth vehicle for a view the book already expresses three ways." },
    },
  });
  const { ok: clean, problems } = auditRun({ root });
  ok("REGRESSION run 10: does not pass the gate", !clean, `got ${problems.length} problems`);
  ok("REGRESSION run 10: catches the closed loop", has(problems, "CLOSED LOOP"));
  ok("REGRESSION run 10: catches the cash trap", has(problems, "CASH TRAP"));
  ok("REGRESSION run 10: catches the unfalsifiable hold", has(problems, "what_would_have_flipped_it"));
  cleanup(root);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
