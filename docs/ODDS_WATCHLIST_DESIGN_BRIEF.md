# Private odds-and-statistics watchlist: confirmed design brief

Date: 2026-09-25
Status: ten-question discovery complete; product scope confirmed. Application implementation, spending, and rollout are not authorized by this document.

## 1. Purpose

Reduce the owner's manual matchup research by surfacing explainable research candidates alongside current, explicitly attributed bookmaker match-winner odds. Statistical differences establish research priority, not a calibrated win probability or proven betting edge.

## 2. Confirmed pilot scope

- One owner-selected PDC competition/session; the exact pilot event remains to be selected before activation.
- Match-winner markets only, explicitly open and prematch.
- Private owner-only Telegram experience. Compact evidence summaries with details available on request; no website dashboard in the pilot.
- Automatic shortlisting within the selected competition, not just user-entered pairings.
- Shadow mode first: record candidates without proactive candidate notifications.
- No automatic betting, staking, accumulators, customer publication, or writes to published tips.
- Free-only odds acquisition: no paid feeds, scraping services, or proxy subscriptions. Existing hosting capacity and maintenance effort still need assessment; no new spending is authorized.
- Requested collection source: OddsPortal darts. Tippmixpro is the priority bookmaker; additional verified bookmakers may be explicitly allowlisted. BoaBet is excluded. Multiple bookmakers are acceptable, superseding the earlier Tippmixpro-only scope. Coverage and permitted access are not yet verified.
- Read-only odds collection: obtain market data only, without bookmaker login, account credentials, betslip interaction, stake submission, or account operations.
- Interpret "live odds" as current prematch prices, preserving the agreed exclusion of in-play markets.
- Every price must name its bookmaker and collection source. An OddsPortal quote is not a directly verified bookmaker quote; never silently substitute or combine prices across bookmakers.

## 3. Feasibility gates, not assumptions

Before automated live collection or notifications, establish permitted access and intended use, a reliable source of the required markets, and applicable internal-use/publication rights. The operator restrictions discussed during discovery remain unresolved; absence of automated bet placement does not establish permission.

Verify provider identifiers, timestamps, event status, market status, start times, update latency, coverage, quotas, costs, and source provenance. A fresh fetch is not necessarily a fresh source price. Manual input or alternative collection methods must not be described as workarounds for usage restrictions.

Publicly viewable/free pages do not by themselves establish permission for automated commercial use. OddsPortal's indexed official terms describe personal-use and scraping restrictions; verify applicable permission before live collection for this paid-service workflow. Source: https://www.oddsportal.com/terms/ (2026-09-25: indexed terms available; direct page fetch returned HTTP 429). Do not bypass CAPTCHA, authentication, geoblocking, or rate limits. Respect source-specific request limits and stop/back off on access denial. If no permitted zero-cost source meets the data contract, report the live feature as infeasible under current constraints rather than introducing a paid or unapproved fallback.

If access remains unresolved, use approved fixtures/sample data for offline design and validation only. Missing live-data capability must remain explicit.

## 4. Eligibility and candidate evaluation

Eligibility is evaluated before statistical shortlisting:

1. Unambiguous canonical players and correctly matched competition, event, and round.
2. Open match-winner market with explicit prematch status and known start time.
3. Fresh odds and sufficiently current historical statistics.
4. Required statistical coverage and stage/floor plus match-format context.
5. No unresolved source contradiction or conflict between the last-10 and last-20 form evidence.

Missing context or conflicting form excludes a candidate from proactive notifications. Such research may remain available on request with warnings. Missing statistics are never zero-filled.

Fetch an ordered last-20 snapshot once and derive last 10 from it. The windows overlap: agreement is a consistency check, not independent statistical confirmation.

Use explicit, deterministic, versioned rules. Numeric statistical thresholds, the exact conflict definition, minimum coverage, history freshness, and any qualifying price condition remain to be proposed and validated during shadow mode. Do not silently invent these as confirmed requirements.

## 5. Confirmed notification policy

There is no three-alerts-per-hour cap. Batching changes presentation, not which qualifying candidates are retained.

### Opening round

- Start a fixed collection window when the first new eligible candidate appears.
- Collect for up to two minutes; subsequent arrivals cannot extend that window.
- Revalidate and send all still-eligible new candidates in a digest grouped by competition/round.
- Later arrivals form additional-candidate digests containing only new qualifiers.
- Do not wait one or two hours for all opening-round markets to appear.

### Later rounds

- Collect new eligible candidates for up to 60 seconds.
- Send one candidate or a grouped digest as appropriate.
- Notify once per canonical matchup; ordinary odds movements do not create repeated notifications.

### Freshness always wins

- Recheck odds and status immediately before notification.
- Require an odds observation no older than two minutes, backed by adequate source-freshness evidence rather than merely a new fetch timestamp.
- Suppress notifications within two minutes of scheduled start, or sooner when live status appears.
- Unknown start/status, suspended markets, stale prices, or failed revalidation mean no proactive notification.
- A candidate that no longer qualifies is suppressed with a recorded reason, not silently counted as delivered.
- Split large digests into readable pages. Do not silently discard qualifying entries; expire and revalidate entries waiting for later pages.
- If Telegram delivery is uncertain, record uncertainty and do not blindly retry. Exactly-once delivery is not promised.

Opening/later-round classification must use verified event/round metadata. The pilot must define a conservative policy for unclassifiable rounds before activation.

## 6. Proposed architecture, subject to feasibility verification

Extend the existing TypeScript application; no new distributed workflow framework.

```text
Authorized odds adapter + existing fixture discovery
  -> validated event/market matching
  -> eligibility checks
  -> player-history/context snapshot
  -> versioned deterministic evaluation
  -> private candidate record
  -> durable batch/deduplication state
  -> pre-send revalidation
  -> existing paced Telegram delivery
  -> owner feedback
```

Reuse existing player resolution, historical statistics, descriptive calculations, cancellation patterns, and Telegram transport policy. Keep monitoring separate from interactive commands so it cannot exhaust their research capacity. Existing per-process pacing is not a cross-instance rate guarantee.

Durable state is needed for candidate history, batch deadlines, overlapping-run prevention, and deduplication across restarts. The owner's existing Supabase deployment is a proposed storage target, not a verified integration. Inspect permissions/configuration before selecting schemas or writing migrations. Keep these records private and separate from published `tips`.

Proposed records:

- Odds snapshots: collection source and source URL, bookmaker identity, source event/market/selection identifiers, canonical mapping, price, status, source update time if supplied, and observation time. Preserve whether a quote was collected directly or through an aggregator.
- Research snapshots: exact historical evidence, context, coverage, observation time, and provenance.
- Evaluations: rule version, snapshot references, qualification/suppression reasons.
- Candidate/batch/delivery records: matchup deduplication key, fixed collection deadline, pending/claimed/sent/uncertain/expired states, and confirmed Telegram identifiers.
- Feedback: useful/not useful/incorrect and optional reason.

Persist a pending notification with its candidate transactionally. Coordinate concurrent runs using a lease/claim and uniqueness constraints. A crash after Telegram acceptance but before recording success remains ambiguous; do not use automatic retries to claim exactly-once delivery.

Scheduler choice and polling cadence remain conditional on hosting capabilities and feed limits. The existing daily MODUS schedule does not implement this monitor. Polling plus research plus batching plus delivery must be budgeted together against the desired 5-10 minute usefulness window; two-minute source freshness may require more frequent observation or a dedicated pre-send fetch.

## 7. Failure and identity guardrails

- Player order reversal must not reverse the selected winner.
- The same players meeting in another round/event are different matchups.
- Withdrawals/replacements invalidate stale mappings and pending candidates.
- Same-day results require verified ordering/identity; date alone is insufficient for point-in-time evaluation.
- Market disappearance is not settlement or proof that no match exists.
- Multiple bookmaker quotes for the same matchup do not create duplicate candidate alerts. Attribute and revalidate each displayed quote independently; an unavailable bookmaker must not silently become another bookmaker's price.
- Outages stop candidate notifications rather than causing stale-data fallback.
- Batch deadlines, evidence timestamps, and source data are persisted; no restart-based duplicate notification loophole.
- Unknown/ambiguous data is quarantined or suppressed with an explicit reason, not guessed by an LLM.
- Authentication, endpoint access control, schema validation, resource bounds, secrets handling, kill switch, and private storage are mandatory implementation requirements.

## 8. Shadow-mode acceptance gates

The owner will review the first 20 shadow-mode candidates and label each useful, not useful, or incorrect, adding reasons when needed.

Before proactive alerts:

- No wrong-player or wrong-market mappings in that reviewed sample.
- At least 10 of 20 candidates worth investigating.
- A measured reduction in research time relative to a documented comparable baseline.
- Verified freshness, prematch exclusion, deduplication, batch timing, and failure handling.

The 20-candidate review is a usability gate, not proof of profitability or future error-free operation. Record suppressed cases too: 20 successful candidates alone do not establish coverage or suppression correctness. If rules change materially, preserve the old evaluation records and validate the revised version before rollout.

Monitor candidate usefulness, time saved, mapping errors, stale/duplicate notifications, missed batching deadlines, source coverage, and collection/maintenance cost. Record operational silence reasons so no-candidate sessions can be distinguished from broken collection.

## 9. Explicit exclusions

No automatic bet placement, stake sizing, value/probability claims, customer-tip publishing, dashboard, accumulators, live betting, 180/checkout markets, new infrastructure purchases, public data exposure, deployment, or changes to existing research outputs in the initial pilot.

Later profitability research requires timestamped odds and point-in-time statistics, temporal out-of-sample evaluation, calibration, and settlement-aware outcomes. The existing selected tips are not a complete evaluation dataset.

## 10. Next deliverable

The gated implementation sequence is documented in [ODDS_WATCHLIST_IMPLEMENTATION_PLAN.md](ODDS_WATCHLIST_IMPLEMENTATION_PLAN.md). Its first gate is a bounded access/data feasibility assessment: permitted-use evidence for OddsPortal and any direct bookmaker sources, verified per-bookmaker market coverage, sample data contracts, freshness/status capability, context availability, capacity within free-only acquisition constraints, and a go/no-go recommendation. The plan does not imply that these gates have passed or authorize coding or rollout.
