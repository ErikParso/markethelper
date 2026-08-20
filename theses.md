# Position theses

One entry per open position. Pionex knows what is held; only this file knows why.
The falsifier is the important line — a swing exit is triggered by thesis invalidation,
not by a headline's mood.

## USOX_USDT — opened 2026-08-20 11:15Z, added 2026-08-20 11:57Z

- **position:** 0.5536750707 units · blended cost basis **135.46** · ~75 USDT (50% of book)
  - leg 1: 0.3698772 @ 135.18 (50 USDT)
  - leg 2: 0.1843521 @ 135.61 (25 USDT) — added on the escalation below
- **thesis:** The US-Iran confrontation is escalating, not resolving, and oil is not pricing
  it. Trump has **cut off talks** and announced the "most crushing economic operation ever
  taken" — secondary sanctions on any country supporting Iran, which removes Iranian barrels
  (~1.5 mb/d) as a matter of supply rather than transit. Iran put ballistic missiles into UAE
  territory; the UAE severed all trade and financial ties. WTI is 87.16 against the 105 it
  printed on 23 July, so persistence alone has room, and escalation has more.
- **falsifier:**
  1. credible restart of US-Iran negotiations
  2. confirmed reopening of Hormuz transit
  3. WTI closing below ~80 (glut beats geopolitics)
  4. *new* — secondary sanctions visibly not enforced: major buyers of Iranian crude
     carrying on unpunished within ~2 weeks. The threat is most of the trade.
- **horizon:** days to weeks. Not months — USOX tracks WTI futures and bleeds on contango,
  and the EIA sees Brent averaging ~69/b in 2027 as inventories rebuild.
- **known risk (two-sided, taken deliberately):** the same blockade that supports price is
  why the IEA and OPEC cut demand ~1.6 mb/d. OPEC+ keeps adding barrels. Trump's pattern is
  escalate-then-deal and a surprise deal is a fast -10%. CNN (08-18) reports Iran has
  *partially lost control* of the strait to US naval patrols — the physical-flow story runs
  against the sanctions story.

### Protection — read this before next run

- **A protective stop is impossible on this venue.** Probed and confirmed 2026-08-20: the
  Pionex spot API accepts `MARKET` and `LIMIT` only. `STOP`, `STOP_LIMIT`, `STOP_LOSS`,
  `STOP_LOSS_LIMIT`, `STOP_MARKET`, `TAKE_PROFIT`, `OCO`, `CONDITIONAL` are all rejected
  with `TRADE_PARAMETER_ERROR: invalid type`. There is also no perpetual order path in the
  CLI, so no clean short. Do not re-probe this; it is settled.
- Downside between runs is therefore **unhedged**. Accepted only because this is unleveraged
  spot — it cannot be liquidated, so the exposure is a bounded drawdown, not a wipeout.
  That reasoning does **not** carry over to any leveraged position.
- **Resting take-profit is live:** SELL 0.193 @ 148.00, orderId `11016007643606584`
  (~WTI 95, +9.2%, ~35% of the position). Those units are **frozen** — a thesis-break exit
  next run must `orders cancel` this first, then sell.
- Sizing was moderated to 50% of book for exactly this reason. Half the account is cash.
