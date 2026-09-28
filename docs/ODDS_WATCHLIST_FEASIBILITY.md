# Watchlist T0 feasibility decision

Date: 2026-09-25
Decision: **NO-GO for unattended live activation under the current evidence.** Ordinary browser access to rendered bookmaker tables is technically verified below. Required permission, complete data capability and production runtime capacity have not been established.

Implementation was requested after the gated plan was finalized. That authorizes starting T0, not treating its unverified dependencies as passed. No application code, production migrations, scheduler changes, or live collection were introduced by this assessment.

## Evidence and remaining gates

| Gate | Evidence | Decision |
| --- | --- | --- |
| Permitted OddsPortal use | Official indexed [terms](https://www.oddsportal.com/terms/) state personal-use-only and commercial-use restrictions in clause 2.2, and describe scraping restrictions. A direct page fetch returned HTTP 429; no repeated requests or bypass attempted. | Not passed: establish permission applicable to this paid-service workflow. Read-only collection does not itself establish permission. This is an engineering access gate, not a legal determination. |
| Free bookmaker coverage | Tippmixpro is requested; BoaBet excluded. No approved event-level sample demonstrates Tippmixpro availability through OddsPortal. | Unverified; do not silently use another bookmaker. |
| Quote/status freshness | No verified permitted source contract for price update time, open market status, prematch status and start time. | Unverified; fetch time alone cannot support the two-minute freshness gate. |
| Scheduler | Repository `vercel.json` contains only the daily MODUS cron. | Frequent scheduling is not implemented; account entitlement and zero-incremental-cost capacity are unverified. |
| Persistence | `package.json` has no Supabase client dependency; the owner's database remains a proposed target. | No verified private watchlist integration, permissions, quota headroom or migration target. Absence of a client dependency alone does not prove no external integration exists. |
| Context/history | Existing schema allows missing fixture start/round; generic history is day-level and does not guarantee format/stage or same-day ordering. | Must demonstrate adequate pilot coverage before proactive evaluation. |
| Product configuration | Pilot event, exact bookmaker allowlist and provisional rule thresholds still require selection/validation. | Cannot claim a rollout-ready monitor. |

## Orchestration

One subagent was launched with `gpt-5.6-luna`, reasoning effort `xhigh`, for a read-only repository feasibility audit. No model substitution, nested delegation, or concurrent coding occurred. The two-subagent ceiling was respected.

## Resume criteria

1. Supply permission evidence for the requested commercial collection/use, or agree on another verified permitted zero-cost source. Do not purchase access or bypass controls.
2. Validate approved event-level samples for bookmaker identity, market/selection mapping, freshness, prematch status and start time.
3. Confirm existing scheduler/database capacity, representative context/history coverage, pilot event and allowlist.
4. Only then advance to T1 of the implementation plan with Luna 5.6 XHIGH coding subagents.

The owner subsequently approved the narrower **offline-only core using synthetic fixtures** while access is unresolved. This scope amendment permits local validation, descriptive screening, batching and deduplication code/tests: no live adapter, schedule, database deployment or Telegram sends. It must not be reported as delivery of the requested live feature. The no-go decision above continues to apply to live implementation.

Checks: planning/configuration and public terms inspection only. No application tests were run because no application code changed. No commits, pushes or deployment performed.

## Follow-up technical inspection after implementation request

The owner requested continued implementation and ordinary public-page collection. Main-agent inspection on 2026-09-25 used a normal in-app browser, without login or access-control bypass:

- `https://www.oddsportal.com/darts/` loaded upcoming/finished matches after client-side rendering. The web text extractor initially showed only navigation; that was not proof of unavailable data.
- Opened a visible upcoming match link: `https://www.oddsportal.com/darts/h2h/owens-jamie-WbmpecDb/taylor-scott-Gbhioxp4/#hYdXZjTN`.
- The rendered match page displayed a table headed `Bookmakers`, `1`, `2`, `Payout`, with individual bookmaker names and two decimal prices per row. This was a MODUS sample, not verification of PDC pilot coverage.
- Tippmixpro was not present in this inspected table. That does not establish global absence or regional coverage.
- The listing explicitly describes best prices across bookmakers. Listing prices must not be attributed to Tippmixpro or combined into a synthetic same-bookmaker pair.
- Rendered player order differed from the H2H URL order. Selection columns must not be mapped to players by URL order.
- The displayed schedule had no observed `time`/`datetime` element with a timezone; no source-price update timestamp was found in the inspected table attributes. A live-streaming label is not live match status.
- Odds links point to bookmaker redirect/betslip destinations. None were clicked or requested. A data-only parser must never follow them.

This supports implementing a bounded **rendered-table parser** that returns attributed observations and explicit unknown metadata, not automatically eligible watchlist quotes. It does not verify unattended browser hosting, precise status/freshness, or permitted commercial use. Keep unknown fields unknown and automatic notifications disabled.
