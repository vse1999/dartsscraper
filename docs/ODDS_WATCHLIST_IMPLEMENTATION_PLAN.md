# Free prematch research watchlist — implementation plan

> Planning update (2026-09-27): the owner-approved replacement local implementation plan is [ODDS_WATCHLIST_FREE_FIRST_PLAN.md](ODDS_WATCHLIST_FREE_FIRST_PLAN.md). This document retains historical decisions; do not restore its conflicting source-timestamp, mandatory-context, bookmaker or polling requirements. Operational rollout remains separately gated.

Date: 2026-09-25
Status: owner approved a narrower offline-only core after T0 did not pass, then requested further implementation and public OddsPortal investigation. Validation, descriptive screening, batching, deduplication, a local replay runner and a rendered-table parser are implemented locally. Ordinary browser inspection verified a public rendered odds table. Unattended collection/alerts remain gated on complete source evidence, verified infrastructure and operational rollout approval; no deployment or production changes have occurred.
Product decisions: [ODDS_WATCHLIST_DESIGN_BRIEF.md](ODDS_WATCHLIST_DESIGN_BRIEF.md).

## 1. Outcome and boundaries

Reduce repetitive matchup research by combining bookmaker prices with descriptive last-10/20 evidence in a private Telegram watchlist. Alerts mean **research candidate**, not proven value, predicted probability, or a recommendation to place a bet.

Initial pilot: one owner-selected PDC competition/session, standard two-outcome prematch match-winner markets, one owner. OddsPortal darts is the requested collection source; Tippmixpro is the priority bookmaker. Other bookmakers require an explicit allowlist entry and verified coverage/access. **BoaBet is excluded.** No promise that OddsPortal carries Tippmixpro is made.

Hard constraints:

- Odds acquisition must be free. No paid feeds, scraping services, proxies, new infrastructure purchases, or automatic upgrades. Check existing hosting/database quota headroom separately.
- Read-only market data: no bookmaker login, credentials, account actions, betslip interaction, wagers, or staking.
- No in-play collection for this feature. "Live odds" means current prematch quotes.
- No account/CAPTCHA/geoblocking bypass, concealed scraping, or ignoring access denials. Public visibility is not proof of permitted commercial collection.
- No website publication, writes to `tips`, dashboard, parlays, 180/checkout markets, or probability/ROI claims in the pilot.
- Existing `/compare`, `/pdc`, and MODUS behavior must remain compatible.

## 2. Verified baseline versus unresolved dependencies

Repository facts checked during planning:

- TypeScript/Node 24, Zod, grammY, Cheerio and Vitest; Vercel deployment configuration.
- Existing player/history resolution, PDC fixture discovery, descriptive statistics, bounded report lifecycle, and paced Telegram delivery can be reused.
- Fixture schema permits unknown round/start time. Generic histories have day-level dates and optional statistics, not guaranteed match timestamps, stage/floor, or match-format metadata.
- `vercel.json` has a daily MODUS cron, not a frequent odds monitor. Per-process pacing/caches do not coordinate independent instances.
- `package.json` has no Supabase client dependency. The owner's existing database is not a verified watchlist integration.

Unverified: permitted free access, actual bookmaker coverage, source freshness/status guarantees, historical ordering/context completeness, scheduler entitlement/capacity, database permissions, pilot event, and useful shortlist thresholds. These are gates, not details an implementer may silently assume.

## 3. Architecture and contracts

Use a modular extension of the existing application. Do not introduce Redis, a message broker, a separate service, or a general workflow framework.

```text
Authenticated bounded scheduler tick
  -> acquire durable run lease / check mode and quotas
  -> permitted odds adapter + existing fixture discovery
  -> validate and reconcile canonical identities
  -> open/prematch/freshness/context gates
  -> bounded shared player-history acquisition
  -> deterministic versioned research rules
  -> transaction: evaluation + candidate + pending delivery membership
  -> due batch claim -> revalidation -> paced Telegram pages
  -> persist confirmed / uncertain outcomes
Owner-only evidence and feedback actions -> private records
```

Proposed boundary: `src/watchlist/` contains contracts, adapters, mapping, evaluation, repository interface, batching, runner, and formatting. Add the smallest authenticated endpoint compatible with existing API conventions only after scheduler verification. Keep transport/parsing separate from pure evaluation and batch logic. Inject clock, repositories, odds/history providers, and transport for tests.

**Normalized quote contract:** collection source and URL, bookmaker ID, provider event/market/selection IDs, canonical event/round and player IDs, selected player ID, decimal price, market type/status, match status, scheduled start in UTC, observed time, provider update time when available, freshness evidence, and mapping provenance. Validate external payloads with Zod. A finite price greater than 1 is necessary, not sufficient, for validity. Reject promotions, boosted/account-specific prices, unsupported market rules, and ambiguous selections.

Do not label aggregator data as directly verified bookmaker data. Never create an implied two-player price pair using different bookmakers. Each displayed quote must independently pass freshness and eligibility checks. Priority display: Tippmixpro if valid; otherwise explicitly name an allowlisted bookmaker. No bookmaker guarantee or silent substitution.

**Identity:** competition occurrence + stable event identity + round + canonical unordered player pair. Selection remains tied to player ID, never column position. Do not key by names/date alone. Reschedules retain identity only with corroborating evidence; replacements/new rounds invalidate old pending candidates. Ambiguous mappings are quarantined, not fuzzy-guessed into alerts.

**Research snapshot:** immutable evidence references, ordered matches, cutoff time, metric denominators/coverage, context provenance, and source observation times. Fetch last 20 once and derive last 10. Preserve existing weighted checkout and 180-per-leg definitions; do not average percentages as if denominators were equal. No missing-value zero filling. Confirm same-day ordering/completion before inclusion; otherwise suppress proactive evaluation rather than use future/ambiguous results.

## 4. Persistence and concurrency

Preferred target: private additive tables in the existing Supabase project, conditional on verified access, quotas, and local testing. Do not modify the public tips schema or depend on the OCR bot. If this target is unavailable, stop for an explicit storage decision; do not ship a serverless in-memory substitute.

Minimum logical records (combine physically only if invariants remain explicit):

1. Validated odds and research snapshots, with source/cutoff provenance.
2. Evaluations with rule version, snapshot references, eligibility and suppression reasons.
3. Candidate records unique per owner + canonical matchup. Preserve deduplication across rule changes, restarts, and bookmaker changes.
4. Batches and per-page delivery records, candidate membership, deadlines, leases, and confirmed Telegram IDs.
5. Owner feedback; run health and collection quota state.

Use transactional candidate/outbox creation, uniqueness constraints, atomic claims, expiring leases with fencing/version checks, and conditional state transitions. A stale worker cannot finalize another worker's claim. Recheck the lease and feature mode before external sends. Keep one active sender per batch.

Delivery states: `pending -> claimed -> sending -> sent`; known invalid data becomes `suppressed/expired`. A crash or ambiguous timeout after send may have started becomes `uncertain`, not automatically retryable. A crashed claim with durable evidence that no send started may return to pending. Store outcomes per page so already-sent pages are not resent after a partial digest failure. Exactly-once Telegram delivery is not promised; reconcile uncertainty manually.

Database failures stop collection/evaluation delivery work safely; never send without durable deduplication state. Require server-only credentials, no public read/write grants, and tested denial of anonymous/ordinary authenticated access. Use repository-local migrations and disposable/local database validation; applying production migrations needs separate approval.

Define retention from permitted-use terms and quota measurements before activation. Keep identity/delivery tombstones for monitored event occurrences even when bulky snapshots expire. Feedback must not reference silently deleted evidence; prevent deletion races with pending delivery. No indefinite raw-page archive.

## 5. Candidate policy and owner workflow

Rule scope: transparent descriptive screening, not a fitted win model. Show averages, weighted checkout, 180/leg, sample coverage, and verified format/stage context for both players. Explain why a candidate qualified and show last-10/20 disagreement rather than hide it.

Before shadow evaluation, freeze a rule specification: exact eligibility fields, minimum samples, freshness for histories/context, delta thresholds and units, optional price filter, and conflict rule. Implement thresholds as validated versioned configuration, not hidden constants or an LLM judgment. Select provisional values using representative evidence and record their rationale; owner reviews them before live shadow collection. No arbitrary numeric threshold is presented here as proven useful. A price filter is a research preference, not evidence of positive expected value.

Proactive exclusions: missing required context/statistics, unresolved last-10/20 conflict, ambiguous history ordering, unknown start/status, unsupported market, stale prices, suspended markets, or mapping uncertainty. Record explicit reason codes. On-request research may show missing-data warnings but must not present blocked cases as eligible alerts.

Owner-only controls, using existing command/callback conventions:

- Status: mode, last successful poll, coverage/suppression counts, backlog, last error, source/bookmaker provenance.
- Shadow review: page through stored candidates without unsolicited candidate messages.
- Evidence: retrieve the exact evaluated snapshot; label historical quotes clearly instead of implying they are current.
- Feedback: useful / not useful / incorrect, with optional reason. Verify owner identity and candidate ownership on every action; duplicate callbacks must be safe.
- Pause/resume: pause is immediate; resuming cannot silently enable alerts if rollout gates are incomplete.

## 6. Timing, batches, and load

- Target end-to-end usefulness: within 5–10 minutes of a source opportunity becoming observable. Measure detection, research, batching, and delivery separately. When true source publication time is unavailable, report only first-observation latency, not claimed source-to-alert latency.
- Proposed polling target: once per minute during the selected session, **only if** source limits and existing hosting support it at no incremental purchase. Otherwise report the target infeasible and request a scope decision; do not conceal slower behavior.
- Opening round: first eligible candidate starts a fixed window of up to 2 minutes; later arrivals cannot extend it. Later arrivals after closure create a new digest.
- Later rounds: fixed 60-second collection window. Unknown round classification blocks proactive delivery until metadata is resolved.
- Include all still-eligible candidates, grouped by competition/round and paginated. No three-per-hour cap. Overload produces explicit expired/suppressed records, not silent truncation.
- Once per canonical matchup across bookmakers; ordinary price moves or changed thresholds do not trigger another alert. If already sent/uncertain, keep new evidence internally without resending.
- Recheck each quote/status before its page is sent: adequate source freshness and observation age <= 2 minutes. Suppress within 2 minutes of scheduled start, or earlier on live status. A new HTTP fetch alone does not prove fresh odds.
- Persist deadlines and resume work across invocations; never sleep in a serverless handler waiting for a batch deadline. Run processing within a bounded execution budget; partial work resumes through durable claims.
- Bound requests, concurrency, response sizes, research fan-out, backlog, and storage growth. Share player snapshots across matchups, invalidate after verified completed matches, and coordinate pacing across monitor instances and existing research traffic. Do not weaken interactive limits to meet watchlist timing.
- Back off on 429/5xx with bounded retries and a single retry owner; stop on access denial or invalid source structure. Repeated failures open a circuit until recovery checks succeed. Freshness limits still apply after recovery.

## 7. Step-by-step delivery tasks and gates

Each task must supply its diff, tests/checks, assumptions, and remaining blockers. Do not proceed past a failed gate.

### T0 — Free-access and capacity feasibility (first, before collection code)

Verify permitted intended use, per-bookmaker coverage, available fields/status/freshness, request limits, and approved representative samples. Record direct versus aggregator provenance. Inspect existing hosting scheduler entitlements and database quota/access without exposing credentials. Measure history fan-out using approved fixtures and choose a representative pilot-session load. Establish a free-only budget and source request allowance.

**Done:** evidence matrix, sample contracts, selected pilot event/bookmaker allowlist, proposed poll/load limits, and explicit go/no-go. If no permitted zero-cost source meets the required contract, stop live implementation. Approved synthetic/sample replay remains a possible offline deliverable, not fulfillment of live monitoring.

### T1 — Contracts and pure domain core

After owner approves implementation and T0 passes, add schemas, repository/provider interfaces, canonical mapping, typed reason codes, freshness gates, and pure evaluation/batching functions. Freeze the provisional versioned rule specification for owner review. Preserve existing research outputs.

**Done:** deterministic offline tests for identities, eligibility, calculations, rule boundaries, and fixed batch deadlines. No production network dependency in tests.

### T2 — Odds and context adapters

Implement one verified source adapter, starting with the approved OddsPortal path if feasible. Do not prebuild speculative bookmaker scrapers. Add allowlisted source URLs, strict parsing, response bounds, cancellation, caching, pacing and backoff. Integrate reusable histories and verified format/stage context with explicit unknowns.

**Done:** authorized/sanitized fixtures cover valid, missing, reordered, malformed, suspended, stale, and denied responses; tests prove no account/bet actions and no silent bookmaker substitution.

### T3 — Private durable state

Implement repository adapter and additive local migrations after checking relevant current Supabase guidance and local conventions. Enforce candidate uniqueness, atomic batch membership, delivery transitions, leases and fencing. Test privacy grants/policies, rollback compatibility, retention, concurrent workers, crashes and restart recovery in a disposable database.

**Done:** race tests demonstrate no duplicate enqueue and conservative ambiguous-send recovery. Migration execution in production remains unauthorized.

### T4 — Bounded runner and scheduling integration

Wire collection, shared history acquisition, evaluation, durable batching and pre-send revalidation. Add authenticated scheduler endpoint, session window, disabled/shadow/alerts modes, kill switch and source-health counters. Default disabled. Ensure overlapping invocations obey durable claims, pacing and time budgets.

**Done:** fake-clock tests plus representative load/replay demonstrate deadline handling and no material regression to interactive commands. Document actual achievable latency and quotas; failure to meet gates stops rollout.

### T5 — Private Telegram workflow

Add compact candidate cards, evidence pagination, status, review and idempotent feedback controls. Reuse existing safe formatting and paced transport. Track per-page results and suppress expired remaining entries. Authorize every command/callback server-side.

**Done:** snapshot/transport tests cover large opening digests, later singletons, malicious source text, wrong-owner actions, partial delivery and uncertain responses. No real Telegram sends during automated tests.

### T6 — Integrated verification and shadow pilot

Run targeted tests, `npm run build`, full `npm test`, and `git diff --check`; review the complete diff and dependency changes. Record unrelated failures and skipped checks honestly. Run offline replay first. After separate deployment/migration/live-collection approval, enable shadow for one session only; no proactive candidate messages.

**Done:** owner labels first 20 shadow candidates; zero wrong-player/market mappings in that sample, at least 10/20 useful, and measured reduction against comparable manual research time. Also review suppressed opportunities, quote freshness, duplicates, timing, coverage and resource use. These are usability gates, not profitability evidence.

### T7 — Controlled alert rollout

Only after owner accepts shadow evidence and explicitly approves alerts, enable private notifications for the selected session. Owner receives a deduplicated operational warning for actionable source/authentication failures, not repeated noise on every poll. Verify pause and rollback before enabling alerts.

**Done:** acceptance evidence and short runbook covering source outage, uncertain delivery, quota exhaustion, bad mappings, restart and rollback. Expansion to other events/bookmakers is a separate measured decision.

## 8. Mandatory test matrix

| Area | Required cases |
| --- | --- |
| Identity | accents/aliases, swapped players, same pair in new round, rematch, replacement, reschedule, missing stable IDs |
| Markets | wrong winner selection, mixed bookmakers, nonstandard market, promotion, invalid price, bookmaker absent, suspension/reopening |
| Time | UTC conversion, DST, unknown/changed start, live before schedule, stale source with fresh fetch, clock boundary, delayed poll |
| Research | fewer than required matches, missing denominators, zero attempts, same-day order, last-10/20 conflict, stale context, new completed match |
| Batching | fixed opening deadline despite continuous arrivals, later 60-second window, duplicate book quotes, unknown round, oversized/partially expired digest |
| Durability | two workers, stale lease holder, crash before/after send, uncertain delivery, database outage, restart, rule-version change |
| Safety | unauthorized scheduler/callback, source HTML injection, allowlist escape/redirect, oversized response, leaked-secret checks, kill switch before send |
| Operations | 429/backoff, malformed source, quota exhaustion, pending queue growth, interactive contention, cold history cache, source recovery |

## 9. Success, rollback, and execution guardrails

Report usefulness (useful/reviewed), incorrect mappings, time saved per comparable matchup/session, valid bookmaker coverage, observation/research/send latency, expired/duplicate/uncertain entries, source failures, and resource use. Set numerical load/resource limits from T0 measurements; do not call unmeasured performance verified. No revenue, ROI, or edge claims from this pilot.

Rollback: disable monitor and alert mode first; prevent further claims/sends, leave existing research commands intact, retain private audit evidence. Do not delete production tables or replay uncertain deliveries as a rollback shortcut. Already-issued Telegram requests cannot be recalled by a kill switch.

Coding orchestration, once authorized: use the user-requested Luna 5.6 at XHIGH where available, maximum two subagents concurrently. Confirm model availability; do not silently substitute. No nested delegation. Main agent owns contracts, integration, reviews and gate acceptance. After T1, T2 adapters and T3 persistence can run in parallel with disjoint file/test scopes and shared interfaces frozen first. T4 depends on both; T5 formatter/tests can run alongside T4 if integration ownership is explicit. Review and verify before the next wave.

All implementers: read local guidance; never use TypeScript `any`; use explicit nontrivial/exported parameter and return types; validate unknown input; inject dependencies for tests; preserve unrelated work; do not read/log secrets, add speculative dependencies, weaken tests, change existing reports, or bypass failed gates. No commits, pushes, production migrations, deployment or external messages without an applicable explicit request.

**Scope amendment after T0:** the owner approved an offline-only core with synthetic fixtures. Implement and verify pure validation, descriptive screening, batching and deduplication without runtime wiring. Its serializable in-memory replay state is a test model, not a substitute for the durable storage required by the live design. Live T0 gates and rollout approvals remain outstanding.
