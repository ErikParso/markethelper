#!/usr/bin/env node
/**
 * Regression tests for the pieces that have actually failed on this book.
 *
 * These run against throwaway fixtures and pure functions — the live account is never
 * touched. Each case is a failure that really happened, so a regression means a habit
 * or bug has come back.
 *
 * (The tests-ledger cases were removed 2026-09-17: that module was retired to archive/
 * on 2026-09-11, and this file kept importing it, so the whole suite had been failing
 * unnoticed for six days.)
 *
 * Usage: node --test lib/protocol-audit.test.mjs   or   node lib/protocol-audit.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inception } from "./score.mjs";
import { MAX_LEVERAGE, roundStep } from "./perp.mjs";
import { bidAbove, offerBelow, roundUnit } from "./ladder.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "\n         " + detail : ""}`); }
};

console.log("\nregression tests\n");

// --- score.mjs must find inception with NO minimum age -------------------
// The bug that hid the benchmark gap for ten runs: scoring was gated behind
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

// --- perp leverage is pinned at 1x ---------------------------------------
// The account defaults to 5x CROSS. There are no stops on this venue and the book is
// checked once a day, so anything above 1x can be liquidated with nobody watching.
ok("REGRESSION: perp.mjs refuses to trade above 1x", MAX_LEVERAGE === 1, `MAX_LEVERAGE is ${MAX_LEVERAGE}`);

// --- sizes round DOWN, never up -------------------------------------------
// A size that rounds up can exceed the cash or the hedge it was sized from.
ok("roundStep rounds down to the contract step", roundStep(0.2699, 0.01) === 0.26);
ok("roundStep keeps an exact multiple", roundStep(0.26, 0.01) === 0.26);
ok("roundStep survives float noise (0.1+0.2)", roundStep(0.1 + 0.2, 0.1) === 0.3);
ok("roundStep of a sub-step size is 0, not a minimum order", roundStep(0.004, 0.01) === 0);

// --- resting orders sit just off round numbers -----------------------------
// A 2,440.00 bid once missed a 2,440.01 low by one cent.
{
  const b = bidAbove(2443.7, 2450);
  ok("an ETH bid sits just ABOVE a round 10", b > 2440 && b < 2441, `got ${b}`);
  const o = offerBelow(2596.2, 2450);
  ok("an ETH offer sits just BELOW a round 10", o < 2600 && o > 2599, `got ${o}`);
  const bb = bidAbove(75300, 76500);
  ok("a BTC bid sits just above a round 250 (within a tenth of the unit)", bb > 75250 && bb < 75275, `got ${bb}`);
  ok("round unit scales with price", roundUnit(76500) === 250 && roundUnit(2450) === 10 && roundUnit(726) === 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
