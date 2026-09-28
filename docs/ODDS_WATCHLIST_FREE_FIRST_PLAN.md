# Free-first prematch research previews: implementation plan v2

Date: 2026-09-27.
Status: owner approved local implementation on 2026-09-27. Account creation, spending, production migration, deployment and live Telegram sends remain separately gated. Progress and verification are recorded separately; this plan is not evidence that every task is complete.

This is the approved local implementation plan. It supersedes conflicting product requirements in `ODDS_WATCHLIST_IMPLEMENTATION_PLAN.md`, `ODDS_WATCHLIST_DESIGN_BRIEF.md` and the earlier feasibility note. Those documents remain historical evidence, not permission to restore rejected requirements. Hosting evidence: `ODDS_WATCHLIST_HOSTING_RESEARCH.md`.

## 1. Outcome and scope

Give the owner a small, explainable shortlist of prematch matchups whose recent performance meets explicit odds-sensitive screening rules. The owner makes the betting decision. A preview is not a calibrated probability, guaranteed edge, stake recommendation or proof of profitability.

Confirmed constraints:

- Hard zero incremental spend. No paid hosting, API, scraper, proxy, auto-upgrade or accidental overage. Reduce coverage/frequency or pause when free resources are insufficient. No promise of free service forever.
- Cloud operation independent of the owner's PC. Target checks every five minutes during monitored sessions and useful previews within 5–10 minutes when capacity permits; this is a target, not a guaranteed SLA.
- PDC coverage is the destination: majors, European Tour and Players Championship where markets exist. Pilot one representative session before expansion.
- Reference bookmaker odds are acceptable with explicit bookmaker and aggregator attribution; owner verifies the available price at their bookmaker. Exclude BoaBet. Do not silently change source identity.
- Recent last-10/20 evidence; stronger evidence required at shorter odds. Few useful previews, not a stream of tiny price updates.
- Optional context may be unknown and visibly labelled. Missing required fields blocks the affected market, not every possible research output.
- Read-only collection. No login/account automation, betslips, wagers, deposits, withdrawals or public publication of tips.

Proposed delivery slice: match-winner first. Add 180 and checkout market rules only as a separate approved extension with verified lines, settlement semantics and sufficient histories. Showing available 180/leg or checkout context in a match-winner preview does not imply those markets are screened. No parlays, OCR changes, dashboard or probability model in v1.

## 2. Existing work and required changes

Verified local modules exist under `src/watchlist/`: contracts, identity, screening/metrics, rendered OddsPortal table parser, batching/snapshots and offline runner. Local replay and tests exist. This is not a deployed collector or durable delivery system.

Reuse rather than rewrite. Explicitly change the older design:

| Earlier behavior | Required v2 behavior |
| --- | --- |
| Required bookmaker update timestamp / strict source-age gate | `observedAt` required; `sourceUpdatedAt` optional and never fabricated. Label observation age, not guaranteed bookmaker freshness. |
| Required stage/floor/format for every candidate | Optional, with provenance and warnings for match-winner previews. Required only when a particular rule depends on that field. |
| Unknown round always blocks | Round is optional display/batch metadata if authoritative event identity prevents rematch collisions. Ambiguous event identity still blocks. |
| Tippmixpro-dependent delivery | A valid named reference bookmaker is sufficient; exclude BoaBet. |
| Once-per-minute proposed polling | Five-minute target, bounded by source limits and free quotas; degraded cadence shown explicitly. |
| Older fixed two-minute TTL across all offline records | Separate observation age, pending-candidate expiry and send-time recheck. Freshness checks must remain meaningful at the selected cadence. |

Inspect all consumers, persisted snapshot schemas, fixtures and boundary tests when changing contracts. Version snapshots; reject incompatible replay/state formats with an actionable error rather than coercing old records. Preserve existing `/compare`, `/pdc` and MODUS behavior. Preserve unrelated working-tree changes, including PDC discovery work.

## 3. Smallest viable architecture

```text
Authenticated scheduled tick (disabled / shadow / alerts)
  -> durable lease + remaining quota reservation
  -> bounded source listing / changed match detail collection
  -> validate event, players, market and bookmaker
  -> shared recent-history cache / refresh
  -> pure versioned screening
  -> durable candidate + delivery intent
  -> due digest: recheck odds/status, re-evaluate if changed
  -> owner-only paced Telegram delivery
  -> confirmed / uncertain delivery state + bounded health metrics
```

Keep one application module and one selected runtime; do not introduce Redis, a queue service, workflow platform or microservice topology. Source adapters, history providers, repository and transport are injected interfaces. Existing parser/calculation code remains transport-independent.

Host selection is an evidence gate, not a preselected purchase:

1. Check existing eligible capacity and ordinary permitted HTTP/JSON acquisition first.
2. If direct collection works, benchmark a minimal Cloudflare Free runtime against its CPU and compatibility limits.
3. If rendering is required, compare complete-run measurements against Cloudflare Browser Run Free and Apify Free. Do not subscribe to a third-party paid Actor.
4. Consider another researched free runtime only if every billable dependency can be disabled or bounded without possible charges. A billing budget notification alone is insufficient for the hard-zero constraint.
5. Select one qualifying host. If none meets the target, offer measured lower cadence or narrower sessions; if none safely works at zero cost, stop live activation and state the limitation.

Free allowance checks include collection, browser startup, retries, pre-send rechecks, cold player histories, storage, logs, scheduling and other workloads sharing the account. Never multiply free accounts or evade quotas. Provider-supported free-plan exhaustion is preferable to relying on approximate application metering to prevent billing.

## 4. Data and eligibility rules

### Required for automatic match-winner previews

- Unambiguous canonical players and occurrence-level event identity; selections mapped to the displayed players, not URL/column assumptions.
- Standard two-outcome match-winner market, valid finite decimal odds greater than one, named bookmaker, explicit available/open market evidence and reliable prematch status.
- Reliable scheduled start with timezone for the pilot. Unknown start/status means no automatic alert; research remains available on request with warnings.
- Source URL/identity, observation time and mapping provenance. Fetch only configured source hosts/routes; validate redirects; never follow bookmaker betting redirects.
- Both players have at least ten unambiguously completed recent matches with required average/checkout evidence. Missing statistics are not zeros.

For averages, state the aggregation definition and retain it consistently. For checkout, use hits/attempts where available. If only match percentages are available, identify the aggregation honestly; do not label their arithmetic mean as a weighted checkout rate. A rule may only compare compatible metric definitions. Missing denominators for a configured weighted rule block that rule.

Fetch up to twenty matches once and derive both windows. If twenty valid matches are unavailable, a valid last-ten comparison can proceed with explicit coverage. If the longer window contradicts the shorter-window direction on required screening metrics, suppress the proactive preview and retain it for manual review. Window policy is versioned and tested.

History must exclude future, unfinished and duplicate matches. Do not invent midnight completion timestamps for date-only history. Use provider ordering or additional completion evidence; if ambiguity changes which matches enter the last-ten cutoff, suppress until resolved. Fetch-time and match-completion time are distinct: a statistics request after an odds observation is not automatically look-ahead if all included results precede the evaluation cutoff.

### Optional context

Stage/floor, format, 180/leg and highest checkout are shown when supported; otherwise show unknown or omit with a compact missing-context note. Do not infer stage/floor solely from event names. Missing context cannot silently become a favorable screening signal. Missing total legs blocks 180/leg calculation, not an otherwise valid match-winner preview.

### Screening configuration

Implement deterministic price bands with explicit non-overlapping boundaries, minimum average differences and checkout percentage-point differences; record rule version and reasons. Stronger thresholds apply to shorter prices. Validate all ranges and impossible/contradictory configurations.

Before shadow evaluation, deliver a complete proposed starter configuration with numerical thresholds, example pass/fail cases (including the owner's 1.83 and 1.42 examples), and an explanation that values are provisional preferences. Do not reverse-engineer thresholds merely to force those examples to pass. No live alert activation until the owner accepts the proposed settings. Keep LLM judgment and invented win probabilities out of qualification.

## 5. Collection, freshness and free-quota behavior

- Poll selected sessions at a proposed five-minute cadence. Poll outside active sessions only where a measured, affordable schedule is needed to discover opening markets. Handle UTC/Budapest DST explicitly.
- Collect useful listing batches first, then necessary details; cache histories by player and validated history version. Refresh after known completed matches and enforce an age policy if completion signals are unavailable.
- Re-read the candidate's market before sending. Proposed send observation limit: two minutes since that successful recheck, with a two-minute pre-start safety buffer. This is an observation-age check, not the rejected requirement for a bookmaker update timestamp.
- If supplied source timestamps show stale or contradictory data, do not ignore them. A fresh fetch cannot establish that upstream data was newly updated.
- Re-evaluate on changed odds; small changes alone do not re-alert. If the event is live, suspended, removed, rescheduled ambiguously or no longer qualifies, cancel the pending candidate.
- Opening candidates use a fixed two-minute grouping window; later candidates a one-minute window. Close on the next available scheduled tick, not by sleeping in a handler or adding a paid scheduler. Document the additional delay in measured end-to-end timing. Unknown round uses a generic digest, not a fabricated classification.
- Arrival does not extend a batch deadline indefinitely. Late arrivals create another digest; there is no promise that all first-day markets appear simultaneously.
- Reserve bounded free resources atomically before a run. Proposed headroom: stop at 80% of the measured free allowance, retaining capacity for rechecks/status. Tune after measurements; do not claim this alone prevents platform charges.
- Degrade by narrowing monitored sessions/events or reducing cadence; expose effective settings. Never relax identity, market or freshness validation to save resources. Backlog is bounded and expires; do not send stale catch-up alerts after recovery.
- Retry transient failures within one bounded retry budget, honor rate limits, and stop on access denials/structural changes. No CAPTCHA, geo/access-control bypass or paid proxies.

## 6. Persistence and delivery guarantees

Reuse the owner's existing private Supabase capacity only after verifying access, free headroom and current project conventions. This is a proposal, not an existing verified integration. If unsuitable, select one free durable alternative during the feasibility gate; do not add a second database speculatively.

Minimum logical data: run lease/quota ledger, bounded evaluation evidence, candidate/delivery outbox, per-page delivery outcomes and owner feedback. Combine records where practical. No changes to the public `tips` table or OCR bot.

- Unique owner + canonical event occurrence prevents repeat previews across restarts, bookmakers and rule changes. Distinct rematches remain distinct. A sent selection reversal updates internal evidence, not another unsolicited bet preview.
- Transactional candidate/outbox creation, atomic claims and fencing tokens prevent competing ticks from sending the same record.
- Delivery: pending -> claimed -> sending -> sent. A timeout/crash after sending may have begun becomes uncertain, not automatically retryable. A Telegram response loss is not proof of failure. Exactly-once delivery is not promised.
- Store pages separately; do not replay confirmed pages after partial failure. Database/lease failure stops sending. Recheck mode and claim before each external call.
- Default-deny public/ordinary-user access; owner authorization on every command/callback. Server-only credentials, parameterized operations, safe Telegram escaping, bounded URLs/payloads and logs without secrets.
- Proposed retention: 14 days of compact evaluation evidence, 30 days aggregate run health, and delivery tombstones through the event plus 90 days, subject to source-use conditions and free storage headroom. Preserve pending/uncertain references during cleanup. Event expiry also prevents old sources recreating deleted candidates.

## 7. Execution tasks and Luna orchestration

Approval of this plan authorizes local implementation tasks only. Deployment, production migrations, purchases and live Telegram sends remain separately gated. Any blocked live dependency must be reported; completed offline work must not be represented as live delivery.

All coding uses exactly `gpt-5.6-luna` with reasoning effort `xhigh`. Maximum two running subagents, no nested delegation, no silent model substitution. Main agent owns task briefs, contract decisions, integration review and acceptance; assign coding fixes back to Luna. Every brief contains file scope, dependencies, prohibited changes, acceptance tests and expected evidence. Shared-file edits are sequential.

| Task | Exact work / output | Acceptance and dependencies |
| --- | --- | --- |
| T0: baseline and feasibility | Record git status without modifying unrelated work; inspect local guidance; establish source-use evidence, sanitized representative samples, full-run resource measurements and zero-charge host/storage decision. Update feasibility note with old versus new gates. | Evidence for one busy opening batch and later-round pairings; actual cloud compatibility assessed only after approved account/deployment access. Missing permission/capacity stops activation, not unrelated offline work. |
| T1: contract migration | Revise contracts, snapshot versions, optional context, observation freshness and typed reason codes. Freeze provider/repository/transport interfaces. Update replay fixtures and tests. | Old formats fail explicitly; new missing-optional-context cases pass; required-data failures remain blocked. This precedes parallel coding. |
| T2A: source/history adapters | Implement only the selected source path, reusing rendered parser where appropriate; canonical mapping, bounded network behavior, history cache/invalidation and honest metric provenance. Own adapter/provider files and their tests. | Sanitized fixture tests cover valid and changed layouts, swapped players, reference books, denied responses and stale/ambiguous data. No betting/account calls. Requires T1 and appropriate T0 source evidence. |
| T2B: durable repository | Implement selected durable adapter, additive local migrations, quota/lease claims, outbox transitions and retention. Own repository/migration files and integration tests. | Disposable/local database concurrency, authorization, crash, fencing and cleanup tests. No production migration. Requires T1 and storage decision; can run alongside T2A with disjoint scope. |
| T3A: runner and cadence | Wire collection, cached histories, deterministic screening, quota reservations, batch deadlines and revalidation. Default disabled; add authenticated scheduler integration for chosen host. Own runner/runtime files and tests. | Fake-clock overlap/restart/quota tests, bounded per-tick work, no regression to interactive commands. Requires T2 interfaces integrated. |
| T3B: Telegram presentation | Implement pure preview formatter and owner-only status/evidence/feedback/pause flows using existing conventions. Include observation time, bookmaker, windows, rule reasons and missing context. Own formatter/command files and tests. | Snapshot, escaping, pagination and wrong-owner tests; mocked transport only. Can run alongside T3A, with main assigning the single shared entrypoint owner. |
| T4: integration and rule specification | Integrate through Luna; propose numerical starter price-band settings, replay realistic sessions and implement all regression fixes. | Build, full tests, diff/security review and evidence matrix pass; no weakened tests or false pass claims. Owner accepts settings before shadow. |
| T5: shadow pilot | After explicit deployment/collection/migration approval, collect/evaluate privately without unsolicited candidate messages. Review outputs and suppressed cases on tournament sessions. | Zero incremental charge, bounded resources, mappings checked, timing/coverage measured and usefulness assessed. Source restrictions and hard-zero gate must pass. |
| T6: private rollout | After owner accepts shadow results and explicitly authorizes notifications, enable one monitored session, test pause/recovery, then expand measured coverage. | Runbook, actual usage evidence, owner-visible degraded state and rollback demonstrated. Broader market scope remains separate. |

Each coding handoff returns changed files, commands and results, unrun checks, assumptions, residual blockers and interface changes. Main reviews each wave before the next. No commits or push unless explicitly requested in the implementation turn.

## 8. Mandatory verification

Use deterministic fixtures and fake clocks; no external calls in unit tests. Add narrow tests first, then `npm run build`, `npm test -- --maxWorkers=2 --minWorkers=1`, replay smoke and whitespace/diff review. Use permitted execution escalation if the environment prevents test processes; never call a blocked test passed.

Required cases:

1. Swapped display/URL order, aliases, same-day rematch, replacement, reschedule, missing stable identity.
2. Reference bookmaker attribution, mixed-book pair rejection, invalid/boosted/suspended prices, BoaBet exclusion, unexpected market semantics.
3. Unknown optional context succeeds with warnings; missing required average/checkout fails; fewer than ten fails; ten without twenty warns; contradictory windows suppress; zero attempts do not become 0%.
4. Date-only histories, ambiguous last-ten boundary, duplicate/future/unfinished matches, new completed match invalidation and stale cache.
5. Observation timestamp versus source update timestamp, future clock, UTC/DST, delayed polls, live-before-schedule and changed price failing a band.
6. Opening batches, late arrivals, next-tick flushing, partial expiration and bounded pagination without silent truncation.
7. Two ticks, stale lease holder, quota reservation race, restart, database loss, crash before/after Telegram send and uncertain delivery.
8. Unauthorized endpoint/callback, source-controlled text/URL injection, redirects off allowlist, oversized payloads, secret leakage and pause immediately before send.
9. Free quota exhaustion, provider outage, recovery, parser drift, cold history load and interference with existing commands.

## 9. Pilot acceptance, monitoring and rollback

Proposed evaluation window: three representative sessions, extending until at least twenty candidate reviews exist if alerts are rare. Review a sample of suppressed cases as well, to avoid measuring usefulness only on the shortlist.

Hard gates: zero observed wrong-player/market mappings, zero automatic duplicate sends in tested failure scenarios, no paid resource use, no known unauthorized access, no invalid-prematch alert, and working pause/restart controls. Any violation blocks expansion.

Product targets, not current evidence: at least half of reviewed candidates considered worth investigating; at least 30% reduction in comparable manual collection/request time. Measure separately from analytical decision time. These are proposed pilot targets subject to owner acceptance, not profitability metrics.

Record observation-to-preview p50/p95 and target p95 <=10 minutes during normal eligible operation. Also report active coverage, missed/expired work and paused time: degraded periods must not disappear from reports. True market-publication-to-alert latency remains unknown without source publication timestamps. If the timing target fails at zero cost, transparently reduce scope/cadence; correctness remains mandatory.

Owner status: mode, effective cadence, last successful collection, stale-source duration, current session coverage, suppressed reason counts, free resource headroom, queue age and uncertain sends. Operational warnings are deduplicated on state change, not every poll. If the host itself is stopped, immediate Telegram warning cannot be guaranteed; retain the last heartbeat and use free provider quota/failure notifications where available.

Rollback: disable new ticks/sends, retain deduplication and uncertainty records, leave existing commands operational, revert the integration through a reviewed change. Do not delete production state or resend uncertain records. A kill switch cannot undo an already-issued Telegram request.

## 10. Approval boundary

Approved: this v2 plan and local implementation sequence. The first implementation deliverable is the updated offline contract/rule behavior plus a current source/zero-cost feasibility report; live operation is delivered only after the separate evidence and rollout gates pass. No host, API or bookmaker is represented as already proven suitable.
