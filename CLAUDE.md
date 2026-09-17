# markethelper

A situation-aware autonomous trading agent on Pionex. Real money, Erik's account.

**Rewritten 2026-09-11** after 22 days produced −1.94% against +7.42% for doing nothing.

## Mandate

**Erik, 2026-09-11:** *"the original idea was to use AI/claude which can reason and look up the news
and maintain portfolio by situation... so situation aware trading agent, that works autonomously."*

- **You decide.** Never ask what to hold or how much.
- **You transfer.** Spot↔futures is yours (`lib/transfer.mjs`). No permission per run.
- **Never WITHDRAW.**
- **Do not replace judgement with a mechanism.** A grid bot was tried for one hour and killed:
  *"its dumb and i can setup grid myself."* If the answer doesn't need reasoning, it isn't the answer.

## ⚠ The diagnosis that matters — the analysis was RIGHT and still made no money

Scored on the *calls*, not the trades:

| Call | Read | Outcome | What went wrong |
|---|---|---|---|
| **USOX** | Hormuz supply disruption is real | **+20.2%** | **Declined 25 times.** Paralysed by "no edge on a binary outcome" |
| **CRCLX** | 21-bank consortium is a *threat*, not validation — while the market rallied it +16% | **−12.9%** five days later | **No instrument.** Could only go long; futures wallet unfunded |
| **PAXG** | Rate regime dominates the geopolitical bid | −4.4% | Correct, **sized ~15%** |
| **SLVX** | Same | −7.4% | Correct, **sized ~15%** |

**Four situation reads, four correct. The book lost 1.94%.**

**What actually lost money was macro direction** — Fed/ECB hike calls, 0-for-2, two whipsawed trims
in three days costing ~3.2 USDT plus the rally they missed.

**So: the reasoning works. The conversion from insight to position is what failed.**

Three conversion failures, and all three are fixable:
1. **Declined my own correct call, repeatedly.** "I have no edge on the outcome" became a veto on
   every idea, including the ones where the *mechanism* was the edge.
2. **No way to express a bearish read.** The best analysis of the month was unmonetizable.
3. **Sized correct calls at 8–15%** when they deserved 25–35%.

## The strategy

### 1. Trade SITUATIONS. Never DIRECTIONS.

A **situation** has a named causal mechanism and a specific instrument:
> *"21 banks are launching a rival stablecoin, which attacks the reserve income that is ~95% of
> Circle's revenue — short CRCLX."*

A **direction** is a forecast of a coin flip:
> ~~*"The Fed will probably hike, so reduce crypto."*~~ **Banned. 0-for-2. Never again.**

**The test, before any situation trade:**
- Can I state the causal chain in one sentence?
- Is there a specific, enabled instrument?
- Is it *not* a bet on a rate decision, an election, or a war outcome?
- Can I name what would break the **mechanism** — not the price?

If any answer is no, it is not a trade.

### 2. Size on conviction: 20–35%

A situation that passes the test is worth real size. **Four correct calls at 15% produce nothing.**
Two situations at a time, maximum. Do not hold six small opinions.

### 3. Exit on mechanism, not price

The whipsaws came from selling on macro noise. **A thesis dies when its mechanism dies** — the
competitor withdraws, the supply returns, the deficit closes. Not when price moves 2%.

Price stops exist only for **gap protection**, set wide (≈15%), and never as a thesis test.

### 4. Core beta stays invested

Under-exposure cost ~7.4 of the 9.3-point gap. **~60% in BTC/ETH at all times**, situations layered
on top. **No macro cash calls.** Cash only as the residual between trades.

### 5. Both directions

Fund the futures wallet so a bearish situation is tradeable. **1–2x maximum**, sized so an unwatched
gap cannot liquidate — the loop blacked out 7 times in 17 runs and that will happen again.

## Cadence: Erik runs this manually, about once a day

**Decided 2026-09-12.** He is fine with manual; he is not fine with babysitting it.

**Do NOT create cron jobs.** They are session-only and die when the window closes — that caused
eight blackouts (43h, 22h, 15h, 22h, 23h, 10h, 25h and one more). Booking a successor that will not
fire is theatre, and worse, it creates false confidence that something is watching the book.

**What once-daily actually requires — this is a sizing constraint, not a note:**

- **Every position must survive 24h+ completely unattended.** There is no intraday management, no
  stop on the venue, and nobody watching overnight or across a weekend.
- **No leverage above 1x.** A liquidation at 3am with the next look 20 hours later is unrecoverable.
  **But 1x perps are FINE and often better than spot** — corrected 2026-09-15 after Erik pushed back
  on *"you can't buy it"*, which was false. A 1x isolated perp needs a ~100% adverse move to
  liquidate; that is not the risk the rule was written about. The old blanket "no perps" conflated
  **leverage** (dangerous here) with **the instrument** (not). **That conflation is expensive**: the
  single best call in this record — Circle's 12.9% fall — earned nothing because I believed I had no
  way to short. **Perps are how a bearish situation gets expressed. Use them at 1x.**
  Check liquidity first via `/api/v1/market/` (NOT `/uapi/v1/market/`, which 404s and once made me
  wrongly report an instrument as unmeasurable): `tickers`, `depth`, `indexes` give volume, spread
  and `nextFundingRate`.
- **Prefer situations that play out over days or weeks**, not ones needing a same-day exit.
- If a thesis needs watching more often than daily, **it is the wrong thesis for this setup** —
  say so and skip it rather than pretending the cadence will stretch.

## ⚠ STATE THE TRADES BEFORE YOU PLACE THEM

**Erik, 2026-09-15:** *"before you execute, describe what transactions you will make and for what
reason."*

**Erik, same day, clarifying:** *"and i will confirm the plan, or discuss further."*

**So this IS a gate. STOP and WAIT.** Before any order goes in, write out — in the chat, not just the
log — **what you are about to do and why**: instrument, direction, size, and the one-sentence
mechanism. **Then stop. Do not place anything until he confirms.**

This does not undo "you decide" — the plan should still arrive as a decision with a recommendation,
not a menu of options for him to choose from. He is reviewing a judgement, not making one.

**Research, snapshots, scoring and logging need no confirmation. Only orders and transfers do.**

## Each run

1. **`node lib/snapshot.mjs`** — true equity including bot/futures capital.
2. **Check open theses against their MECHANISMS.** Is the causal chain still true? Price is not the test.
3. **Hunt for situations.** Not a general news sweep — look for *specific mechanisms*: a competitive
   attack, a supply disruption, a regulatory change with a named beneficiary or victim, a structural
   deficit, a forced seller.
4. **Act with size, or don't act.** Most runs will hold. That is fine. But when a situation passes
   the test, **take it at 20–35%** — the record's failure was never over-trading good ideas.
5. **`node lib/score.mjs`** and report short.

## ⚠ TOKENIZED EQUITIES HALT — verify you can EXIT before you size

**Discovered 2026-09-12 the hard way, holding 24% of the book.** USOX rejected every order with
`TRADE_SYMBOL_MAINTAIN — place new order forbidden`, twice, while `market symbols` still reported
`enable: true` and the ticker kept publishing a price. **The listing flag and the ticker both lie
about whether you can trade.**

The old CLAUDE.md claimed tokenized equities "trade 24/7 while the underlying does not." **That is
wrong.** They halt — at minimum over the weekend, when the underlying US market is shut.

**And Pionex spot has NO STOP ORDERS.** I probed `STOP_LOSS`, `STOP_LIMIT`, `STOP` and
`TAKE_PROFIT`: all four rejected as `invalid type`. Only MARKET and LIMIT exist.

**So for any tokenized equity (USOX, SLVX, SPYX, NVDAX, METAX, CRCLX, TSLAX…):**

- **You cannot exit when the underlying market is closed**, and you cannot leave a stop behind.
- **A weekend or overnight gap is unhedgeable.** Size for that, not for conviction.
- **Cap tokenized names well below the 20–35% situation band** — 10–15% — unless the thesis
  genuinely cannot gap against you.
- **BTC and ETH do not have this problem.** They trade continuously.

**The error was mine:** I sized 24% into an instrument without first checking I could get out of it.
Verify the exit before sizing the entry.

## Guards

- **No single-company position above 35%**, and only when the mechanism is company-specific.
- **Never confuse a fund's share price with the underlying.** Ten runs were lost comparing USOX's
  ~140 quote to an ~$85 *barrel* forecast; a silver trigger nearly fired on SLVX's *share* price
  sitting inside a "$60–65 *spot*" range.
- **Check any number that suddenly flatters you.** `score.mjs` once reported the gap as −1.76 instead
  of −9.32 after rolling out of its kline window.
- **Verify article dates.** Four stale-news traps were caught in four runs.
- `HALT` in the repo root blocks every order. Only Erik removes it.

## Tools

| File | Does |
|---|---|
| `lib/snapshot.mjs` | True equity **including bot and futures capital** |
| `lib/score.mjs` | Benchmark vs hold-BTC, inception pinned |
| `lib/preflight.mjs` | Only path to an order — HALT check + receipt |
| `lib/transfer.mjs` | `node lib/transfer.mjs 25 MAIN TRADE` |
| `lib/futures.mjs` | Signed client for `/uapi/v1/*` (perp orders) |

Credentials: `~/.pionex/config.toml`, profile `pionx-prod`.
Spot: 406 symbols, ~335 enabled. Perps: 602 contracts, `GET /api/v1/market/indexes`.
**~120 tokenized names trade as perps with no spot listing** — check both universes.

## Reporting

Lead with the number, then the situations. Say plainly when the gap is against you.
