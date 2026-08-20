---
description: Evidence-backed hold/trim/close read on current Pionex positions
---

Run the /signal protocol in CLAUDE.md.

Argument (optional): $ARGUMENTS
- empty      → full sweep of all open positions
- a symbol   → that position only, deeper
- `--score`  → skip the sweep; re-score decisions/ entries older than 30 days
               against what actually happened, and report the hit rate

Rules that override any instinct to be helpful:
- Read-only. Never call a trade, cancel, or transfer tool.
- Fetch every number. Never state a price or level from memory.
- Default to WAIT / NO-SIGNAL. A quiet market produces a short report.
- Every non-HOLD verdict needs sources with URLs and a restated falsifier.
- Check "already priced in" before calling anything a signal.
- Finish by appending the run to decisions/YYYY-MM-DD.md.
