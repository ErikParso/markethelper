#!/usr/bin/env node
/**
 * Registered-tests ledger.
 *
 * WHY THIS EXISTS
 * ---------------
 * At run 6 (2026-08-20) this book wrote down a genuine, falsifiable test:
 *
 *   "Watch whether gold reclaims participation on the next fiscal headline. If the
 *    next long-end shock again leaves gold flat while crypto takes the move, the
 *    vehicle is wrong even though the thesis is right — and that is a REALLOCATION
 *    decision, not a falsifier."
 *
 * The test then resolved TWICE, both times against gold, and runs 7, 8, 9 and 10
 * all read past it. The cost was measurable: the book ran +1.02% since inception
 * against +7.59% for simply holding BTC, losing 6.5 points almost entirely through
 * holding 86% in the slower vehicle for a thesis it had correctly identified.
 *
 * A prediction nobody is forced to revisit is a diary entry, not a test. This ledger
 * makes each one a tracked object with a status, and lib/runcheck.mjs refuses to let
 * a run end while a test is RESOLVED but not ACTED ON — or while an OPEN test has
 * been carried, untouched, for more runs than its own deadline allows.
 *
 * Statuses:
 *   open     — registered, not yet decided. Must be re-checked every run.
 *   resolved — the condition fired. `acted_on` must then be set true with a note.
 *   retired  — no longer meaningful; requires a reason.
 *
 * Usage:
 *   node lib/tests-ledger.mjs list            # show every test and its status
 *   node lib/tests-ledger.mjs check           # exit 1 if any test needs attention
 *   node lib/tests-ledger.mjs add '<json>'    # register a new test
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER = resolve(ROOT, "state", "registered-tests.json");
export const STATUSES = ["open", "resolved", "retired"];
const MIN_NOTE = 40;

export function load(path = LEDGER) {
  if (!existsSync(path)) return { tests: [] };
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return { tests: [], _corrupt: true }; }
}

export function save(data, path = LEDGER) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Validate the ledger. Returns { ok, problems[] } to fold into runcheck.
 * `currentRun` lets the staleness rule measure age in runs rather than wall time,
 * since this agent's clock is "runs", not days.
 */
export function checkLedger({ path = LEDGER, currentRun = null, staleAfterRuns = 4 } = {}) {
  const problems = [];
  const data = load(path);
  if (data._corrupt) return { ok: false, problems: ["state/registered-tests.json is not valid JSON."] };

  for (const t of data.tests ?? []) {
    const id = t.id ?? "(unnamed)";
    if (!STATUSES.includes(t.status)) {
      problems.push(`test "${id}": status must be one of ${STATUSES.join("|")}.`);
      continue;
    }

    // The run-6 failure exactly: resolved, and then nothing happened.
    if (t.status === "resolved" && !t.acted_on) {
      problems.push(
        `test "${id}" RESOLVED BUT NOT ACTED ON: "${t.claim ?? ""}". ` +
        `A test that fired and changed nothing is the run-6 failure repeating — it cost 6.5 points of ` +
        `benchmark underperformance. Either act on it and set acted_on with a note, or retire it with a reason.`,
      );
    }
    if (t.status === "resolved" && t.acted_on && String(t.acted_on_note ?? "").trim().length < MIN_NOTE) {
      problems.push(`test "${id}": acted_on is set but acted_on_note is too short to say what was actually done.`);
    }
    if (t.status === "retired" && String(t.retired_reason ?? "").trim().length < MIN_NOTE) {
      problems.push(`test "${id}": retired without a real reason.`);
    }

    // An open test nobody has looked at for several runs is a diary entry again.
    if (t.status === "open" && currentRun !== null && Number.isFinite(Number(t.last_checked_run))) {
      const age = Number(currentRun) - Number(t.last_checked_run);
      if (age > staleAfterRuns) {
        problems.push(
          `test "${id}" has not been checked for ${age} runs (limit ${staleAfterRuns}): "${t.claim ?? ""}". ` +
          `Re-check it and update last_checked_run, or retire it.`,
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---- CLI -----------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];

  if (cmd === "list") {
    const { tests = [] } = load();
    if (!tests.length) { console.log("no registered tests."); process.exit(0); }
    for (const t of tests) {
      const flag = t.status === "resolved" && !t.acted_on ? "  <-- NEEDS ACTION" : "";
      console.log(`[${String(t.status).toUpperCase().padEnd(8)}] ${t.id}${flag}`);
      console.log(`   claim: ${t.claim}`);
      console.log(`   resolves_when: ${t.resolves_when}`);
      if (t.acted_on_note) console.log(`   acted: ${t.acted_on_note}`);
      console.log("");
    }
    process.exit(0);
  }

  if (cmd === "check") {
    const { ok, problems } = checkLedger({ currentRun: Number(process.argv[3]) || null });
    if (ok) { console.log("LEDGER CLEAN — no test is waiting on action."); process.exit(0); }
    console.log("LEDGER NEEDS ATTENTION\n  - " + problems.join("\n  - "));
    process.exit(1);
  }

  if (cmd === "add") {
    let t;
    try { t = JSON.parse(process.argv[3] ?? ""); }
    catch { console.error(`usage: node lib/tests-ledger.mjs add '{"id":"...","claim":"...","resolves_when":"..."}'`); process.exit(2); }
    for (const k of ["id", "claim", "resolves_when"]) {
      if (!String(t[k] ?? "").trim()) { console.error(`missing required field "${k}"`); process.exit(2); }
    }
    const data = load();
    data.tests ??= [];
    if (data.tests.some((x) => x.id === t.id)) { console.error(`test "${t.id}" already exists`); process.exit(2); }
    data.tests.push({ status: "open", acted_on: false, ...t });
    save(data);
    console.log(`registered "${t.id}"`);
    process.exit(0);
  }

  console.error("usage: node lib/tests-ledger.mjs list|check|add");
  process.exit(2);
}
