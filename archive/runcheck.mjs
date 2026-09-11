#!/usr/bin/env node
/**
 * End-of-run audit gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * lib/coverage.mjs stops the run-4 failure: deploying capital without sweeping.
 * It cannot stop the OPPOSITE failure, which is what runs 6, 7, 9 and 10 did:
 * sweeping diligently, writing PASS on every theme, and never trading at all.
 * Coverage is only consulted by preflight, and a run that places no order never
 * calls preflight — so a do-nothing run was completely unaudited.
 *
 * Run 10 (2026-08-21) returned PASS on 8 of 8 themes. Erik challenged it. The
 * audit found a CLOSED LOOP: the semiconductor short was rejected as "the same
 * view the book already holds" (too correlated) while TSLAX was rejected as "a
 * hedge against my own thesis" (too anticorrelated). Those two tests are jointly
 * exhaustive — together they reject every asset that exists. Each rejection had a
 * real argument attached, so the ratchet was invisible from inside any single
 * decision. Only the pattern across runs exposed it.
 *
 * The first attempt to fix this wrote the corrected rule into theses.md and
 * coverage.json. Both are gitignored, and `coverage.mjs init` DELETES coverage.json
 * at the start of every run — so that fix would have evaporated within one run.
 * Hence a checked-in gate that exits non-zero, on the same principle coverage.mjs
 * states in its own header: prose has been skipped before, a gate has not.
 *
 * Usage:
 *   node lib/runcheck.mjs            # audit; exit 0 = clean, 1 = problems
 *   node lib/runcheck.mjs --json     # machine-readable
 *   node lib/runcheck.mjs --explain  # include the rule text for each finding
 *
 * This gate does NOT block orders and has no opinion on what to trade. It refuses
 * to let a run END while a structural defect is present and undeclared.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => resolve(ROOT, ...s);
const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fb);

const MIN_JUSTIFICATION = 60; // long enough that "nothing looked good" cannot pass

/** Phrases that veto an idea for being CORRELATED with the book. */
const CORRELATION_VETO = [
  /same view/i, /already hold/i, /already holds/i, /doubling down/i,
  /second vehicle for the same/i, /fourth vehicle/i, /third vehicle/i,
  /view the book already/i, /correlated single-view/i,
];

/** Phrases that veto an idea for being ANTICORRELATED with the book. */
const ANTICORRELATION_VETO = [
  /hedge against my own/i, /against my own thesis/i, /wrong side of (this|the) book/i,
  /mirror image of this book/i, /own both sides/i, /opposite side of (this|the) thesis/i,
];

/**
 * Everything from a correction marker onward is PROVENANCE, not live reasoning.
 *
 * A corrected rejection has to be able to quote the bad reasoning it replaced —
 * that record is the most valuable part of the file — but the scanner would then
 * flag the correction itself forever. So only the text BEFORE the marker counts as
 * the operative reason. This is a deliberate, documented escape hatch: writing the
 * marker and then continuing to reason from the loop defeats the only reader it
 * protects, which is the next run.
 */
const CORRECTION_MARKER = /(⚠\s*)?CORRECTED\b/i;
const operative = (s) => String(s ?? "").split(CORRECTION_MARKER)[0];

// ---------------------------------------------------------------------------

/** Every decision recorded across the trade logs, oldest first. */
export function decisionHistory(root = ROOT) {
  const dir = resolve(root, "trades");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
    const t = readJSON(join(dir, file));
    if (!t) continue;
    for (const [k, v] of Object.entries(t)) {
      const m = /^run(\d+)_decision$/.exec(k);
      if (!m || !v || typeof v !== "object") continue;
      const action = String(v.action ?? v.verdict ?? "");
      out.push({ run: Number(m[1]), file, action, traded: /^\s*TRADED/i.test(action) });
    }
  }
  return out.sort((a, b) => a.run - b.run);
}

/** How many of the most recent consecutive runs recorded no trade. */
export function noTradeStreak(history = decisionHistory()) {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].traded) break;
    n++;
  }
  return n;
}

/**
 * Audit the run. Returns { ok, problems[] } so this can be folded into other
 * tooling the same way checkCoverage() is.
 */
export function auditRun({ streakLimit = 2, root = ROOT } = {}) {
  const problems = [];
  const cov = readJSON(resolve(root, "state", "coverage.json"));
  const acct = readJSON(resolve(root, "state", "account.json"));
  const policy = readJSON(resolve(root, "policy.json"), {});
  const history = decisionHistory(root);
  const streak = noTradeStreak(history);

  // ---- 1. CLOSED LOOP: correlated AND anticorrelated both used as vetoes ----
  // The defect that produced run 10. Jointly-exhaustive rejection criteria reject
  // the entire investable universe, so the sweep can never produce a trade.
  if (cov?.themes) {
    const corr = [], anti = [];
    for (const [name, t] of Object.entries(cov.themes)) {
      if (t?.verdict !== "PASS") continue;
      const text = `${operative(t.why_passed)} ${operative(t.finding)}`;
      if (CORRELATION_VETO.some((r) => r.test(text))) corr.push(name);
      if (ANTICORRELATION_VETO.some((r) => r.test(text))) anti.push(name);
    }
    if (corr.length && anti.length) {
      problems.push(
        `CLOSED LOOP: theme(s) [${corr.join(", ")}] were rejected for being too CORRELATED with the book, ` +
        `while theme(s) [${anti.join(", ")}] were rejected for being too ANTICORRELATED. Those two tests are ` +
        `jointly exhaustive — together they reject every asset that exists. Correlation is a SIZING input, ` +
        `never a veto: if an idea beats a held position, swap into it. Anticorrelation is not a defect either ` +
        `— a concentrated book facing a dated unhedgeable event is exactly the book that wants a hedge. ` +
        `Re-decide at least one of these on its merits, or record why the pair is genuinely not exhaustive here.`,
      );
    }
  }

  // ---- 2. "Priced in" must carry a NUMBER, not a narrative. ----------------
  // "The market already moved on this" can be said of anything that moved, while
  // anything that has not moved has no catalyst — so unquantified, it rejects
  // everything. Run 10's oil rejection was sound precisely because it was numeric
  // (Brent 92.68 against the EIA's own $85 forecast).
  if (cov?.themes) {
    for (const [name, t] of Object.entries(cov.themes)) {
      if (t?.verdict !== "PASS") continue;
      const text = operative(t.why_passed);
      if (/priced[- ]in/i.test(text) && !/\d/.test(text)) {
        problems.push(
          `theme "${name}": rejected as "priced in" with no number anywhere in the reasoning. State it as ` +
          `"X trades at A against a credible independent estimate of B", or drop the priced-in claim.`,
        );
      }
    }
  }

  // ---- 3. An unfalsifiable hold. ------------------------------------------
  // A no-trade run must name the specific, checkable fact that would have flipped
  // it. Holds with no stated trigger compound into paralysis across runs.
  if (streak >= streakLimit) {
    const flip = String(cov?.what_would_have_flipped_it ?? "").trim();
    if (flip.length < MIN_JUSTIFICATION) {
      problems.push(
        `NO-TRADE STREAK of ${streak} runs (limit ${streakLimit}) and coverage.json has no usable ` +
        `"what_would_have_flipped_it". Name the specific checkable fact that would have produced a trade ` +
        `this run — a price, a level, a datapoint, a headline. An unfalsifiable hold is not a decision.`,
      );
    }
    const ranked = cov?.ranked_candidates;
    if (!Array.isArray(ranked) || ranked.length < 2) {
      problems.push(
        `NO-TRADE STREAK of ${streak} runs and coverage.json has no "ranked_candidates" array with at least ` +
        `two entries. Rank the candidates against EACH OTHER first, then send the winner against the book — ` +
        `comparing each candidate to the incumbent separately lets the incumbent win N separate duels.`,
      );
    }
  }

  // ---- 4. The mechanical trap: cash below one venue minimum. ---------------
  // Between runs 8 and 10 cash sat at 0.70 against a 10 USDT minimum, so buying
  // required selling and selling required beating an incumbent. A closed system.
  const minNotional = Number(policy?.capital?.min_notional_usdt ?? 10);
  const cash = Number(acct?.cash_usdt ?? NaN);
  if (Number.isFinite(cash) && cash < minNotional) {
    const ack = String(cov?.full_deployment_is_deliberate ?? "").trim();
    if (ack.length < MIN_JUSTIFICATION) {
      problems.push(
        `CASH TRAP: cash is ${cash.toFixed(2)} USDT, below the ${minNotional} USDT venue minimum, so the NEXT ` +
        `run cannot buy anything without first selling — and selling requires beating an incumbent. Either ` +
        `raise cash above one minimum, or record "full_deployment_is_deliberate" in coverage.json saying why ` +
        `being unable to act is the right state to leave the book in.`,
      );
    }
  }

  return { ok: problems.length === 0, problems, streak, history };
}

// ---- CLI -----------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { ok, problems, streak, history } = auditRun();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok, streak, problems, history }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  const recent = history.slice(-6).map((h) => `run ${h.run}: ${h.traded ? "TRADED" : "no trade"}`);
  console.log(`RUN AUDIT — last ${recent.length} decisions`);
  for (const r of recent) console.log(`  ${r}`);
  console.log(`  current no-trade streak: ${streak}\n`);
  if (ok) { console.log("CLEAN — no structural defect detected."); process.exit(0); }
  console.log("PROBLEMS\n  - " + problems.join("\n\n  - "));
  process.exit(1);
}
