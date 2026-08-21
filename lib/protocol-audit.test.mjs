#!/usr/bin/env node
/**
 * Tests for the compliance gates: lib/tests-ledger.mjs and lib/score.mjs.
 *
 * These run against throwaway fixtures — the live book is never touched. The
 * point of each case is a failure that ACTUALLY HAPPENED in runs 6-10, so a
 * regression here means the trader has resumed a habit it was caught doing.
 *
 * Usage: node lib/protocol-audit.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLedger } from "./tests-ledger.mjs";
import { inception } from "./score.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "\n         " + detail : ""}`); }
};
const has = (ps, needle) => ps.some((x) => x.includes(needle));

function ledgerFile(tests) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "registered-tests.json");
  writeFileSync(path, JSON.stringify({ tests }));
  return { path, dir };
}

console.log("\ncompliance gates\n");

// --- THE run-6 failure: a test fired and nothing happened ------------------
{
  const { path, dir } = ledgerFile([{
    id: "vehicle-gold-vs-crypto", status: "resolved", acted_on: false,
    claim: "gold may be the wrong vehicle for the thesis",
  }]);
  const { ok: clean, problems } = checkLedger({ path });
  ok("REGRESSION run 6: resolved-but-not-acted-on is caught", !clean && has(problems, "RESOLVED BUT NOT ACTED ON"));
  rmSync(dir, { recursive: true, force: true });
}

// --- Acting on it clears the flag, but only with a real note ---------------
{
  const { path, dir } = ledgerFile([{
    id: "v", status: "resolved", acted_on: true,
    acted_on_note: "Rotated 25 USDT PAXG into BTC, taking metals from 86.3% to 54.7% of the book.",
    claim: "c",
  }]);
  ok("acting on a resolved test with a real note passes", checkLedger({ path }).ok);
  rmSync(dir, { recursive: true, force: true });
}
{
  const { path, dir } = ledgerFile([{ id: "v", status: "resolved", acted_on: true, acted_on_note: "done", claim: "c" }]);
  ok("a token acted_on_note is rejected", has(checkLedger({ path }).problems, "too short"));
  rmSync(dir, { recursive: true, force: true });
}

// --- Retiring a test needs a reason, not a shrug --------------------------
{
  const { path, dir } = ledgerFile([{ id: "v", status: "retired", retired_reason: "n/a", claim: "c" }]);
  ok("retiring without a real reason is rejected", has(checkLedger({ path }).problems, "retired without a real reason"));
  rmSync(dir, { recursive: true, force: true });
}

// --- An open test nobody revisits becomes a diary entry again -------------
{
  const { path, dir } = ledgerFile([{ id: "v", status: "open", claim: "c", last_checked_run: 6 }]);
  const { problems } = checkLedger({ path, currentRun: 11, staleAfterRuns: 4 });
  ok("REGRESSION runs 7-10: an open test unchecked for 5 runs is caught", has(problems, "has not been checked"));
  rmSync(dir, { recursive: true, force: true });
}
{
  const { path, dir } = ledgerFile([{ id: "v", status: "open", claim: "c", last_checked_run: 10 }]);
  ok("a freshly checked open test passes", checkLedger({ path, currentRun: 11 }).ok);
  rmSync(dir, { recursive: true, force: true });
}

// --- Bad status is a schema error, not a silent pass ----------------------
{
  const { path, dir } = ledgerFile([{ id: "v", status: "maybe", claim: "c" }]);
  ok("an unknown status is rejected", has(checkLedger({ path }).problems, "status must be one of"));
  rmSync(dir, { recursive: true, force: true });
}

// --- score.mjs must find inception with NO minimum age -------------------
// The bug that hid the benchmark gap for ten runs: CLAUDE.md gated scoring behind
// "trades older than 30 days", so on a 2-day-old book it could never run at all.
{
  const root = mkdtempSync(join(tmpdir(), "score-"));
  mkdirSync(join(root, "trades"), { recursive: true });
  writeFileSync(join(root, "trades", "2026-08-20.json"), JSON.stringify({
    equity_start_usdt: 149.77,
    orders: [{ ts: "2026-08-20T11:15:12Z" }, { ts: "2026-08-20T15:01:14Z" }],
  }));
  const inc = inception(root);
  ok("REGRESSION: inception is found on a book only hours old", inc !== null);
  ok("inception uses the EARLIEST order", inc?.ts === Date.parse("2026-08-20T11:15:12Z"));
  ok("inception carries starting equity", inc?.equity === 149.77);
  rmSync(root, { recursive: true, force: true });
}
{
  const root = mkdtempSync(join(tmpdir(), "score-"));
  mkdirSync(join(root, "trades"), { recursive: true });
  ok("no trades yet -> no inception, rather than a crash", inception(root) === null);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
