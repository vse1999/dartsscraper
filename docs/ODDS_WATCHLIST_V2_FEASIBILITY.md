# Odds watchlist v2 feasibility audit

Date: 2026-09-27
Scope: local, read-only T0 audit and documentation update. No credentials, account calls, deployment, spending, production migration, scheduler activation, bookmaker action, or Telegram send was performed.

## Decision

**Offline/domain work is locally implementable. Unattended collection and delivery are not yet feasible to claim.**

The repository already contains a useful pure watchlist core and a bounded rendered-table parser. It does not contain a live odds transport, a durable watchlist repository, a frequent scheduler, or a verified source/history contract for proactive previews. The v2 plan therefore permits contract and adapter-boundary work with synthetic/sanitized fixtures, but live activation remains a separate gate.

This is an engineering access/capability decision, not a legal conclusion. The source-use question remains unresolved; public visibility or read-only behavior must not be treated as permission for this workflow.

## Facts verified in the repository

### Existing watchlist core

- `src/watchlist/` contains Zod contracts, canonical identity, metric aggregation, screening, batching, snapshot validation, an offline runner, and an OddsPortal rendered-table parser.
- `scripts/watchlist-replay.ts` accepts a bounded JSON scenario and prints a result; it performs no network, database, scheduler, or Telegram work.
- The parser accepts captured HTML only. It recognizes a single exact `Bookmakers / 1 / 2 / Payout` table, attributes both prices to one bookmaker row, rejects disabled/malformed/conflicting rows, and allowlists HTTPS `oddsportal.com/darts/` URLs. It intentionally returns `eventStatus`, `scheduledStart`, `sourceUpdatedAt`, round, and player mapping as unknown. Its fixture URLs and prices are synthetic.
- Offline batching is a sequential state machine. Snapshot version is `1`; state includes candidate/page terminal states and conservative `uncertain` recovery, but no lease, fencing token, cross-process claim, or durable database.
- Current offline contracts are stricter than the v2 plan: `WatchlistQuoteSchema` requires `round`, `scheduledStart`, `sourceUpdatedAt`, and a complete `eventContext`; history requires `playedAt`, `completedAt`, and complete context. This is a known T1 migration item, not evidence that a source can supply those fields.

### Existing history/statistics path

The reusable path is DartsOrakel, not a watchlist history adapter:

- `src/dartsorakel/client.ts` calls JSON endpoints for a numeric player ID, accepts ISO **date** ranges, limits, statistic rank keys, retries bounded 408/429/5xx responses, and can use the generic `FileCache`.
- `src/dartsorakel/parser.ts` validates rows containing `tournament_key`, `event_key`, `match_date`, nullable round, winner/loser IDs, score and statistic cells. It filters byes/incomplete results, de-duplicates using a composite of tournament/event/date/round/players/scores, and sorts by `date` descending.
- The parser does **not** receive a durable provider match ID, an exact played timestamp, a completion timestamp, timezone, stage/floor, format, or a provider guarantee that same-day row order is chronological. Date-only rows must not be converted to fabricated midnight completion times.
- Consequently, the current `HistorySnapshotSchema` cannot be populated honestly from DartsOrakel alone: it requires non-null event/round/stage/floor/format context and `playedAt`/`completedAt` timestamps that this path does not expose. The v2 contract migration must make optional context explicit rather than inserting placeholders.
- Average is parsed as a numeric match value. Enriched 180s are taken from the relevant statistic cell. Checkout is honestly derived from non-negative `hits` and `attempts`; when attempts are zero the percentage is unavailable. A displayed percentage must agree with `hits / attempts` or parsing fails. If correlated metric rows are not one-to-one, the metric remains unavailable rather than being joined by response position.
- `DartsOrakelScraper` requests a bounded recent window (90/180/365/730-day expansion, then 1900-01-01 fallback), fetches up to a requested limit with a minimum request batch, and makes separate average/180/checkout calls. This is useful raw evidence but is not yet sufficient to prove a valid last-10/20 cutoff for an alert.
- `PlayerMatchesService` caches by normalized name, limit, and local date boundary. `SnapshotStore` is process memory; `FileCache` is local disk and best-effort. Neither is a shared watchlist history cache or durable invalidation log.

### Existing runtime and delivery

- `package.json` has Node 24, Zod, Cheerio, grammY and Vitest, but no Supabase/database client and no watchlist-specific persistence package.
- `vercel.json` has only the once-daily MODUS cron. No five-minute scheduler, watchlist endpoint, run lease, quota ledger, or watchlist route is configured.
- Existing Telegram code provides owner checks, 4,096-character formatting limits, pagination patterns, escaping/length discipline and paced delivery policy. It is reusable as an injected/mock transport, but no watchlist formatter or outbox integration exists.
- The working tree contains unrelated PDC edits and the watchlist implementation/docs as untracked work. T0 must not reset, stage, or rewrite those changes.

## Evidence versus unverified gates

| Area | What is actually evidenced | Current status / blocker |
| --- | --- | --- |
| Source shape | A prior visible browser inspection found a rendered OddsPortal two-price bookmaker table for one MODUS matchup. URL/column order differed; no timezone-bearing start element or bookmaker update timestamp was observed. | Enough to justify a quarantined rendered-table parser. Not enough for normalized quotes, PDC coverage, status, freshness, or player-selection mapping. |
| Source transport | No watchlist network adapter exists. The parser consumes caller-supplied captured HTML. Existing DartsOrakel JSON is a separate history path. | Local adapter interfaces/fixtures are implementable. Live collection is not implemented and must not be implied. |
| Source/use conditions | `ODDS_WATCHLIST_FEASIBILITY.md` and hosting research record unresolved source-use/commercial eligibility and an earlier HTTP 429 without retries or bypass. | Gate remains open. Do not make a legal claim, repeat scraping, bypass controls, or silently change source. |
| Bookmaker coverage | The inspected table did not demonstrate Tippmixpro. The v2 plan allows any explicitly named valid bookmaker except BoaBet. | Event-level bookmaker coverage and selection semantics remain unverified. No bookmaker substitution is allowed. |
| Freshness/status | `observedAt` can be recorded at collection time. No verified source contract provides source update time, open/prematch status, or start time in the inspected table. | v2 may label observation age; `sourceUpdatedAt` stays optional and must never be fabricated. Automatic alerting still needs reliable start/status and a recheck contract. |
| History dates/order | DartsOrakel supplies date-only rows, nullable round and no durable match ID/completion timestamp. | Existing raw metrics can feed descriptive research; proactive last-10/20 requires an explicit ordering/completion policy and suppression when same-day ambiguity changes the cutoff. |
| History percentages | Checkout hits/attempts are available on one-to-one enriched rows and the parser derives a weighted-compatible percentage. Match-level displayed percentages alone are not accepted as a weighted denominator. | Reusable metric parsing is credible. Coverage, denominator provenance, zero-attempt behavior and unavailable metrics must remain visible. |
| Persistence | Only in-process snapshots and best-effort local file cache exist. | No shared lease, quota reservation, candidate/outbox transaction, fencing, or retention implementation. A local repository adapter can be built/tested; no production migration is authorized. |
| Scheduler/host | Existing Vercel config has one daily MODUS cron. Hosting research lists conditional provider allowances but no account plan, region, entitlement, browser benchmark, or measured run. | Zero-charge cloud capability remains unverified. No deployment or scheduler selection follows from advertised limits. |
| Delivery | Existing Telegram sender/policy is real application code, but watchlist pages, evidence records and uncertain outbox transitions are absent. | Pure formatting and mocked transport are locally implementable. Live sends remain explicitly disabled. |

## Can the source-field contract be implemented honestly now?

**Only at the raw-evidence boundary.** A source adapter can honestly return a bounded observation with:

- source kind/ID/URL and collection `observedAt`;
- provider event/market/bookmaker identifiers when explicitly present;
- both decimal prices only when the same named bookmaker row supplies them;
- raw display labels and mapping status (`resolved`, `unknown`, or `ambiguous`);
- optional `sourceUpdatedAt`, `scheduledStart`, round, market status and event status, preserved as unknown when absent; and
- structured warnings for shell responses, denied access, stale/contradictory source data, and parser drift.

It cannot honestly emit a v2 eligible `WatchlistQuote` from the current parser alone. The parser has no player mapping, event occurrence identity, market semantics beyond an unverified two-outcome table, prematch status, start time, or source update timestamp. The current strict quote schema also demands fields the parser intentionally leaves unknown. The correct implementation is a raw-source evidence type followed by a separate resolver/normalizer that fails closed; not a default value, fabricated timestamp, URL-order mapping, or synthetic bookmaker freshness.

## Required architecture boundaries before any live adapter

The following interfaces are the smallest useful seams. They can be implemented against fixtures and fakes locally without selecting a provider or host.

### 1. Odds source adapter

Separate raw acquisition from normalization. The adapter should accept a bounded session/event request and an `AbortSignal`, and return raw observations plus source-health metadata. It must enforce host/route allowlists, response-size limits, pacing, cancellation, retry classification, and redirect rejection. A normalizer then maps raw data to a quote candidate only if it can prove:

1. canonical occurrence/event identity and both player IDs;
2. the selected player is tied to a provider selection ID, not a display/URL column;
3. one named, allowlisted bookmaker supplies the price;
4. standard match-winner semantics, finite decimal price, open/prematch evidence and a reliable scheduled start; and
5. `observedAt` and provenance are retained, with `sourceUpdatedAt` optional.

Unknown optional context may pass to a research preview with a warning. Missing required identity/market/start/status blocks that market only. BoaBet must be rejected; no implicit Tippmixpro assumption is valid.

### 2. History adapter with honest cutoff semantics

Do not pass generic `Match` rows directly into the watchlist domain. Define a watchlist history result that preserves provider identity and ordering quality, for example:

```text
HistorySnapshot {
  playerId, source, observedAt, cutoffAt,
  matches: CompletedHistoryMatch[] or quarantined entries,
  ordering: exact_timestamp | provider_order | date_only_ambiguous,
  coverageWarnings
}

CompletedHistoryMatch {
  providerMatchId: string | null,
  playedOn: YYYY-MM-DD,
  completedAt: ISO timestamp | null,
  completionEvidence: explicit | result_complete | unknown,
  opponentId/name, result, score, optional round/context,
  metrics: { average, oneEighties, checkoutHits, checkoutAttempts,
             checkoutPercentage, percentageDefinition, metricEvidence }
}
```

This is a boundary proposal, not a claim that the current provider fills it. A provider match ID may be synthesized only from a documented stable provider identity; a composite key is not an exact ID. `completedAt` must be null when the source gives only a date. A last-10/20 selector may use exact completion timestamps, or a documented provider ordering guarantee; if two same-day rows can change the cutoff and neither is resolvable, suppress proactive evaluation. Never invent midnight, infer a format/stage from tournament text, or turn missing metrics into zeros.

Metrics must retain denominator/provenance:

- Average: arithmetic mean of available match averages, with available-match coverage.
- Checkout: weighted `sum(hits) / sum(attempts)` only for valid positive denominators; zero attempts produce unavailable percentage. If only a provider percentage exists without counts, mark it as source-reported/non-weighted and do not use it for a weighted rule.
- 180/leg: `sum(180s) / sum(legs)` only where legs and 180 counts are both present. Missing legs blocks this metric, not necessarily match-winner research.

The adapter should expose cache key `(provider, playerId, historyVersion, cutoffPolicy)` and explicit invalidation after a verified completed match. Existing `SnapshotStore`/`FileCache` are reusable mechanisms for local tests, not substitutes for shared durable state.

### 3. Pure evaluator and evidence record

The evaluator should receive a normalized quote, two history snapshots, a versioned rule config, and an injected clock; it returns eligibility, typed reasons, metric coverage, and immutable evidence references. It must distinguish observation age from source publication/update age. Keep `sourceUpdatedAt` absent when unavailable. Re-evaluate changed odds before any future delivery.

### 4. Repository and runner seams

Define (without implementing production storage yet) interfaces for run lease/quota reservation, immutable evaluation/snapshot write, owner-scoped candidate upsert, due-batch claim with fencing, per-page delivery outcome, uncertainty/tombstone retention, and pause/mode state. A repository failure must stop collection/delivery rather than fall back to in-memory sends. The offline snapshot state is useful as a deterministic model but cannot claim cross-instance safety.

### 5. Presentation/transport seam

Add a pure preview formatter that receives evidence records and emits bounded Telegram pages, including observation time, named bookmaker, price, selected player, last-10/20 values, denominator coverage, rule reasons and missing-context warnings. Reuse the existing `TELEGRAM_MAX_TEXT_LENGTH` and pagination conventions. Inject `TelegramMessageSender` only behind a mocked transport in local tests; keep owner authorization and uncertain-send behavior in the future command/repository layer.

## v2 gate changes versus rejected older requirements

These changes are intentional and must be reflected in contracts/tests rather than reintroducing old gates:

| Rejected/old assumption | v2 rule | Audit consequence |
| --- | --- | --- |
| A bookmaker update timestamp is mandatory and fetch time proves freshness. | `observedAt` is mandatory; `sourceUpdatedAt` is optional and never fabricated. | Current parser may record observations but cannot prove source freshness. Use observation-age labels and a pre-send recheck later. |
| Stage/floor/format required for every candidate. | Optional context is shown as unknown; only rules that depend on a field block. | Current DartsOrakel/aggregator context gaps do not block every research preview, but they block context-dependent rules. |
| Unknown round always blocks. | Unknown round may use a generic digest if authoritative event identity prevents rematch collisions. | Current offline batching still suppresses unknown-round candidates; migration to v2 semantics is a domain-core task. |
| Tippmixpro is the only usable bookmaker. | Any explicitly named valid reference bookmaker is acceptable; BoaBet excluded. | Coverage must be measured and attributed per bookmaker; never combine best prices across rows/books. |
| One-minute polling and one fixed two-minute TTL for every record. | Five-minute target bounded by source/free quota; separate observation age, candidate expiry and send-time recheck. | Existing `quoteMaxAgeMs` hard cap and replay freshness logic require a deliberate v2 contract migration. |
| 180/checkout market expansion in the first slice. | Match-winner first; those fields can be display context but are not separate screened markets. | Do not build speculative market adapters or claims. |

## Locally implementable tasks and actual blockers

### Safe now (no external access required)

1. Migrate schemas/snapshots to v2 optional-context and observation-age semantics with explicit incompatible-version errors; preserve current commands.
2. Add the raw-source evidence and history-adapter interfaces above, Zod boundary schemas, typed warnings/reason codes, and fixture-only normalizers. Keep unknown values unknown.
3. Add a DartsOrakel history normalization fixture path that preserves `tournament_key`/`event_key`/player IDs and metric denominator provenance, while marking date-only order/completion as ambiguous where appropriate. Do not call the live service from tests.
4. Add pure preview formatting, quota/cadence policy calculations, and mocked Telegram pagination/escaping tests. Do not add a live route or send.
5. Add repository contract tests against an in-memory fake that exercise candidate uniqueness, page claims, fencing, uncertain-send recovery, and retention without a production database.
6. Add fake-clock runner tests for five-minute target/degraded cadence, fixed opening/later windows, changed-odds re-evaluation, history invalidation, and bounded quota reservation. Keep the feature disabled and out of existing API composition.

### Must remain blocked pending evidence/approval

- Choosing or operating an odds source for this workflow, including commercial/use eligibility and event-level bookmaker coverage.
- Treating the rendered OddsPortal sample as a direct bookmaker feed, resolving its player/selection order, or following bookmaker/betslip redirects.
- Claiming a source update timestamp, start time, open/prematch status, PDC coverage, or last-10/20 ordering that the source did not provide.
- Selecting a host/scheduler/database based only on advertised free allowances. Required evidence is account entitlement, region/runtime compatibility, a representative measured run (including cold histories/rechecks), storage/log/quota usage, and a zero-charge safety decision.
- Supabase/database account inspection, production migrations, deployment, webhook/scheduler registration, paid upgrades, and live Telegram sends.

## Recommended next local coding task

After the domain-core contract migration, the highest-value bounded task is **a fixture-only DartsOrakel-to-watchlist history normalization boundary**. Preserve source event/player IDs and metric denominators; represent `playedOn` versus `completedAt` separately; mark date-only/same-day ambiguity explicitly; and return a typed suppression rather than choosing a fake cutoff. This exercises the exact remaining data risk without inventing a live source or database.

In parallel only where file ownership is disjoint, a pure Telegram preview formatter plus quota/cadence policy can reuse established sender/pagination conventions. It should render evidence and warnings from immutable records and use mocked transport only. Do not wire either task to a live scheduler, Supabase, bookmaker, or Telegram token.

## Verification and residual risk

Required local tests should cover swapped players, rematches/replacements, same-day history ambiguity, missing denominators, zero attempts, source-controlled text/URLs, unknown context/round, incompatible snapshot versions, quota degradation, and uncertain delivery. No external calls belong in these tests.

The main task reports the existing baseline build and test suite passing (413 tests across 49 files); this documentation-only audit did not rerun those commands. The reported pass does not verify live source access, permission, hosting, scheduler cadence, storage durability, or alert usefulness. No cloud, account, or source evidence in this document should be read as approval for deployment or production behavior.
