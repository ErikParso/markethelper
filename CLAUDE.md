# markethelper

Autonomous trading on Pionex. Real money, Erik's account.

**Rewritten from scratch 2026-09-11**, after 22 days and 61 runs produced **−1.94% against +7.42%
for doing nothing**. The old file is in git history. Everything below is derived from that record,
not from theory.

## Mandate

**Erik, 2026-09-11:** *"lets change the strategy completely, redo it from the scratch... the only 2
condition is — you make the decisions, you make the transfers."*

- **You decide.** Never ask him what to hold or how much. That is the job.
- **You transfer.** Internal spot↔futures moves are yours (`lib/transfer.mjs`). No permission per run.
- **You never WITHDRAW.** Money leaving the exchange is not trading and was never asked for.
- Objective: increase what the account holds.

## ⚠ What the record actually proved

| | |
|---|---|
| 22 days, 61 runs, 62 orders, 744 USDT turnover (5× the book) | **−1.94%** |
| Doing literally nothing (hold BTC) | **+7.42%** |
| Realised P&L across every order | **−1.6 USDT** |
| Fees | **−0.31 USDT** |

**Trading cost about 1.9 USDT. The other ~7.4 points was NOT BEING INVESTED.** Execution was never
the problem. Exposure was.

**Three more facts that shaped the rewrite:**

1. **62% of runs produced a report and no trade.** Roughly 1,200 web searches over the month, and
   the research almost never converted into a position.
2. **The loop blacked out 7 times in 17 runs** (43h, 22h, 15h, 22h, 23h, 10h, 25h). Cron is
   session-only and dies with the window. **I exist maybe 30% of the time; the market runs 24/7.**
   One blackout left an armed stop unexecuted for a day.
3. **What actually worked was mechanical, not clever.** The trap screen (7-for-7 refusals), the one
   falsifier that fired and executed, and the crude manual ladder of resting bids — the only
   mechanism in the whole record that ended positive.

**What lost money was discretion:** two whipsawed macro trims in three days, and both single-name
bets (USOX, CRCLX).

## The strategy

**Stop trying to be present. Make the strategy not need me.**

1. **~100% deployed, always.** Idle cash is a guaranteed 0% and it cost most of the gap. There is no
   "waiting for CPI". No macro cash calls, ever.
2. **Two held positions + one grid bot.** BTC and ETH held for beta; a **spot grid bot** harvesting
   volatility 24/7 on the exchange, which keeps working through every blackout.
3. **No discretionary directional trading.** No macro forecasts, no single companies, no leverage.
4. **Grid on the more volatile asset.** Harvest scales with volatility — ETH averages ~4.0% daily
   range against BTC's ~2.2%.

### Be honest about what this earns

Pionex advertises ~87% annualised on grid bots. **That is a sales number.** My own arithmetic:
0.61% spacing − 0.10% round-trip fees = 0.51% net per completed cycle, at ~6.6 grid crossings a day
→ **roughly 3–10% annualised on the deployed slice, ≈3%/yr on the book.**

**So the grid is a yield add-on, not the engine. The engine is beta.** This tool's realistic job is
to **match the market plus a small mechanical yield, while not losing to it through discretion.**
Anything more would need leverage, and leverage plus a loop that dies 40% of the time is how the
book gets destroyed. Revisit only if the grid proves itself over weeks.

## Each run — monitoring, not trading

Once or twice a day is enough. A run is ~5 minutes, not 20 searches.

```bash
node lib/snapshot.mjs      # true equity INCLUDING bot capital
node lib/score.mjs         # benchmark vs holding BTC
pionex-trade-cli --profile pionx-prod bot order_list
```

1. **Snapshot.** Confirm equity, weights, bot still running.
2. **Check the three kill levels below.** That is the whole risk process.
3. **Redeploy any idle cash** above ~5% of the book. Grid profit accumulates as quote — sweep it back.
4. **Report short.** What the book did, what the grid earned, the benchmark gap. No essays.

**Do not run a world sweep unless a kill level fired.** The month proved the research does not
convert; it produced reports, not returns.

## Kill levels — the entire risk system

| What | Level | Action |
|---|---|---|
| **Grid range breaks** | ETH closes below **2,050** two sessions | Cancel the bot. Do not average through the floor |
| **Book drawdown** | Equity below **132** (−10% from 146.87) | Halve crypto exposure, report, stop trading until Erik responds |
| **Grid not earning** | < ~0.3%/month realised on deployed capital after 30 days | Kill the bot, move the capital to simple holding |

`HALT` in the repo root still blocks every order. Create it if account data is stale, inconsistent,
or you cannot explain what happened. **Only Erik deletes it.**

## Instruments

- **Spot only for now.** BTC, ETH, and grid bots on them.
- **No single companies.** Both worst outcomes in the record were single names.
- **Perps are reachable** (`lib/transfer.mjs`, tested both directions) **and deliberately unused.**
  Liquidation at 3am with no stop-loss type on this venue, against a loop that blacks out — no.

## Two mistakes that will recur — guard them

1. **Never confuse a fund's share price with the underlying.** Ten runs were spent comparing USOX's
   ~140 quote to an ~$85 *barrel* forecast, and a silver trigger nearly fired because SLVX's 60.85
   *share* price sat inside a "$60–65 *spot*" range.
2. **Check any number that suddenly flatters you.** `score.mjs` rolled out of its kline window and
   reported the gap as −1.76 instead of −9.32. The ladder metric once read "4-for-4" while every
   fill was underwater. **Measurements that improve on their own are broken, not good news.**

## Tools

| File | Does |
|---|---|
| `lib/snapshot.mjs` | True equity **including bot capital** → `state/account.json` |
| `lib/score.mjs` | Benchmark vs hold-BTC. Inception price pinned |
| `lib/preflight.mjs` | Only path to an order. HALT check + receipt |
| `lib/transfer.mjs` | Spot↔futures. `node lib/transfer.mjs 25 MAIN TRADE` |
| `lib/futures.mjs` | Signed client for `/uapi/v1/*` |

Credentials: `~/.pionex/config.toml`, profile `pionx-prod`.

**Retired:** `coverage.mjs`, `runcheck.mjs`, `ladder-score.mjs`, `tests-ledger.mjs` and the
research protocol they enforced. They policed a discretionary trading style this strategy no longer
has — gates on a process that was itself the problem.

## Reporting

Lead with the number. Book value, change, benchmark gap, grid earnings. Then anything that broke.
**Say plainly when the gap is against you**, and never present a narrowing gap as skill when it is
just being less exposed to something that fell.
