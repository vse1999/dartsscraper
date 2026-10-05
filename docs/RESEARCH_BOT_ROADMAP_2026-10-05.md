# Research bot: highest-ROI decision-intelligence roadmap

Date: 2026-10-05. Scope: repository inspection and primary-source research; proposals only. No application implementation, paid service, deployment, collection schedule, or Telegram send was authorized or performed.

## Executive decision

Strengthen evidence, comparability, automation reliability, and evaluation before expanding sources or upgrading the language model. Interpret the "$10m project" request as investment-grade rigor, not a spending authorization. Retain the project's private, free-first research boundaries unless separately changed.

The product goal is trustworthy, timely, reproducible matchup research that saves manual work. Prediction and odds-value functionality are later, conditional capabilities, not properties of the current descriptive reports. "All useful data" means prioritized coverage and explicit gaps, not exhaustive scraping.

## Evidence from the current application

- `src/services/matchup-analysis.ts`: high/medium/low confidence depends on match counts and average coverage. A two-point average difference triggers a form signal; a three-point difference between short-window trends triggers momentum. These are deterministic descriptive heuristics, not calibrated forecasts.
- `src/value/reader.ts` and `src/value/metrics.ts`: /value joins odds to one history per resolved identity and derives overlapping last-10/20 windows. Context is always unknown. It deliberately has no probability or value policy.
- `src/schemas/match.ts`: ordinary match records contain date, tournament, opponent name, score and a few statistics, but no canonical opponent/event IDs, completion timestamps, match format, darts thrown, or legs denominator. Raw DartsOrakel parsing does have additional identifiers.
- `src/watchlist/dartsorakel-history.ts` and the watchlist contracts preserve more identity/evidence and guard ambiguous date-only cutoffs. They are offline infrastructure, not a deployed live research pipeline. Reuse these ideas, not the assumption that live collection already works.
- `src/telegram/stats-service.ts` and `src/dartsorakel/scraper.ts`: bulk enrichment requests average, 180 and checkout views, with starts paced 3.2 seconds apart. With 32 cold players, 96 requests span approximately 95 x 3.2 = 304 seconds before the last launch, excluding directory work, extra lookbacks, retries and final response latency. That exceeds the documented 220-second PDC research allowance. This is a capacity calculation, not a measured production failure rate.
- `src/services/player-matches.ts`: the cache key includes requested count and name, and the signal-bound cold path does isolated loading rather than populating the SnapshotStore. Existing deduplication/caches help, but do not establish durable canonical cross-report reuse.
- `docs/ODDS_WATCHLIST_V2_PROGRESS.md`: local screening/replay/quota proposals exist; durable database/outbox, live adapter integration, cloud scheduler and notification rollout remain unimplemented.
- `docs/ODDS_STATISTICS_COMPARISONS.md` reports historical local runs around 74 and 83 seconds for four odds matchups. These are dated observations, not a current benchmark or scale guarantee.

## Eight ranked investments

Effort bands are relative: S = bounded local change; M = adapters and cross-module integration; L = longitudinal data and model work. ROI is an informed hypothesis, not measured financial return.

### 1. Evidence ledger and explicit data-quality gate — very high expected ROI; M

Preserve source player/event/match identities, observation time, source update time when published, completion precision, source URL, parser version, payload hash, query scope and completeness. Distinguish raw observations from corrected/normalized records. Preserve history rather than overwriting it when a source corrects a score.

Expose separate identity, freshness, completeness, metric coverage and comparability statuses. Rename coverage-only confidence to data coverage. A freshly retrieved page is not proof of a freshly updated source. Unknown completion time remains unknown; no invented midnight timestamp.

Start with the existing sources and a versioned local archive for an offline pilot. Hosted persistence needs an approved durable store; serverless local files are not a production ledger. Retain raw data only where source terms permit, with private access and bounded retention.

Acceptance: each displayed metric and descriptive signal traces to its exact evidence; contradictory identities are quarantined; replay reproduces a report without current network data; corrections do not rewrite what was originally known.

### 2. Shared ingestion, incremental refresh and resumable automation — very high expected ROI; M/L

Separate fixture discovery, history acquisition, analysis and delivery. Maintain a canonical player-history snapshot reusable across /pdc, /compare and /value; derive requested windows locally. Refresh when a new completed match or changed fixture justifies it, rather than re-fetching all historical views for every command.

Coordinate source request allowances across workers/instances. Add checkpointed per-player work, explicit pending/partial/failed states and conservative delivery recovery. Deduplicate owner requests and protect interactive commands from monitoring workload. Prewarm known participants before permitted scheduled reports; refresh odds independently near observation/delivery.

Do not solve quota pressure by blindly increasing concurrency. Jina's published no-key Reader allowance is 20 RPM per IP, while key-based use has separate entitlements/token constraints. Vercel Hobby cron is daily and may run anywhere in its scheduled hour, so it does not support precise frequent monitoring by itself. Account/hosting changes require separate approval. [Jina Reader](https://jina.ai/reader/), [Vercel cron pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Acceptance: benchmark representative 4/16/32-player cold and warm slates; record source calls, cache hits, complete-card fraction, p50/p95 latency and deadline failures. Test overlapping runs and restart recovery. No duplicate confirmed digest or automatic retry of uncertain Telegram delivery.

### 3. Comparable player-statistics engine — very high expected ROI; M

Add disjoint recent-versus-prior windows (last 10 versus previous 10), calendar windows, days covered, effective sample sizes, median/spread and outlier sensitivity. Last-10 and last-20 remain useful summaries, but their overlap is not independent confirmation.

Keep weighted checkout hits/attempts. Normalize 180s by known legs or scoring visits where definitions permit; 180s per match confound performance with match length. Calculate true pooled scoring averages only with compatible points/darts denominators; otherwise label the existing arithmetic mean of match averages honestly. Do not infer legs from a score until its sets-versus-legs semantics are proven.

Investigate first-nine scoring, throw splits and 140 frequency. A public DartsOrakel player page exposes these at a last-12-month aggregate level, but that does not establish per-match availability or complete coverage. Do not relabel those aggregates as recent-match data. [DartsOrakel statistics](https://dartsorakel.com/player/stats/1993/darren-beveridge).

Acceptance: unequal match lengths, partial denominators, sparse checkout attempts, outliers and overlapping windows have explicit regression fixtures. Source scope is displayed beside each metric.

### 4. Opponent- and format-aware matchup context — high expected ROI; M/L

Connect verified event format, double-in/standard rules, sets/legs, match length, stage/floor and current round. Preserve opponent IDs to support schedule-strength-aware ratings. Compute descriptive context splits first; evaluate whether they add predictive information before assigning coefficients.

Use an Elo-style baseline for opponent-adjusted results; scoring performance and win record answer different questions. Shrink sparse format-specific samples toward an appropriate longer-term baseline. H2H must display its search period and completeness rather than treating no meeting in the latest ten as no historical meeting.

Double-start is a real format distinction: PDC explicitly describes it for the World Grand Prix. It motivates separate context, not a guaranteed adjustment formula. [PDC Grand Prix report](https://www.pdc.tv/news/2025/10/11/2025-boyle-sports-world-grand-prix-semi-finals-latest).

Acceptance: no cross-format normalization without definitions; late replacements invalidate old context; unknown context remains visible. Retain opponent/context adjustments only when held-out evaluation or demonstrated research usefulness supports them.

### 5. Point-in-time evaluation lab — high foundational ROI; M

Archive what the system knew before each match, including fixture/odds/history observations, rules, analysis version and eventual result. Later-discovered historical rows must not be assumed available at the earlier decision time.

Use calendar-based walk-forward evaluation with tournament/session grouping. Fit hyperparameters and calibration on earlier, separate data; retain an untouched later test period. Compare existing form heuristics, Elo, transparent statistical models and timestamp-aligned market baselines. Ablate feature groups to identify data that actually helps.

Track log loss, Brier score, calibration curves with bin counts, subgroup performance and coverage/abstention. Brier alone is not a pure calibration measure. Do not treat a small pilot or a favorable selected streak as evidence of prediction quality. [Calibration documentation](https://scikit-learn.org/stable/modules/calibration.html), [Time-series split limitations](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).

Acceptance: automated future-information checks; evaluation includes excluded/missing matches and reasons; performance is reported with uncertainty and scope. Synthetic watchlist replay tests pipeline correctness, not forecasting efficacy.

### 6. Compact decision brief and owner-feedback loop — high immediate ROI; S/M

Lead every matchup with the relevant differences, their denominators, contrary evidence, format, data quality and missing facts. Details remain on demand. Preserve the full collected inventory even if a separate research-priority view is sorted.

Ask what additional data could change the comparison. Fetch that evidence only if its expected usefulness warrants cost/latency. Add useful/not useful/incorrect buttons and a source-error reason. Collect feedback on all displayed reports, not just retrospectively successful candidates.

Keep calculations and eligibility deterministic. An optional LLM explains only a bounded evidence bundle; numeric claims must reconcile with structured fields, and unsupported injury/motivation narratives are prohibited.

Acceptance: compare manual research time before/after on the same representative slate; record usefulness, correction rate and ignored digests. The existing first-20-candidate review can assess usability, not profitability or calibration.

### 7. Odds observation history and transparent market comparison — high conditional ROI; M

Archive permitted paired prices with exact bookmaker, source, event/market/selection IDs, observed time, source-update time when supplied and status. Add opening/current/closing observations only when actual snapshots exist; no reconstructed prices or unverified actionable quote claims.

For the same two-outcome market and observation, report overround and a transparent proportional-margin baseline:

`qA = (1 / oddsA) / ((1 / oddsA) + (1 / oddsB))`.

This is an estimated market baseline, not true probability. Do not mix bookmaker sides, event occurrences, market rules or timestamp windows. Additional bookmakers require demonstrated coverage and permitted access; existing OddsPortal parser evidence is not a live-source license or complete adapter.

Acceptance: exact market joins, stale/suspended detection, both-price completeness and a visible provenance trail. Market movement is context, not proof of informed money. Closing-price comparisons are diagnostics, not proof of profitability.

### 8. Calibrated prediction and uncertainty-aware comparison — potentially high ROI; L, conditional

Only after the ledger, context and evaluation exist, test a small regularized model against Elo and market baselines. Inputs may include opponent-adjusted strength, recency-weighted scoring, weighted finishing, normalized 180s and verified format. No generative-model probability guesses.

Separate estimated win probability, probability uncertainty, data quality and market disagreement. Estimate probability sensitivity using an appropriate validated resampling/model approach; do not convert a confidence interval on average into a win-probability interval. Abstain for poor identity, unfamiliar formats, sparse history or drift.

If odds-value research is separately approved, a simple two-outcome decimal-price comparison is `p * odds - 1` before fees/other adjustments, but an uncertain/unvalidated p makes the result unreliable. This roadmap does not establish an edge or recommend wagers.

Acceptance: repeatable held-out improvement, acceptable subgroup calibration, uncertainty disclosure, shadow operation, rollback and drift monitoring. If it fails to beat a simpler baseline, keep the descriptive bot rather than shipping sophisticated-looking false precision.

## Delivery sequence and investment gates

1. Baseline current latency, completeness, errors and owner research time. Implement the confidence-label clarification and preserve observation metadata first.
2. Build ledger/canonical cache, normalized summaries and compact briefs (#1/#2/#3/#6). These improve research without a predictive promise.
3. Verify richer-stat contracts and event context; collect point-in-time evaluation and odds observations (#4/#5/#7). Shadow only; no proactive delivery activation.
4. Consider probabilities (#8) only if data volume, calibration and held-out evidence justify them. Expand sources only if a coverage gap or ablation experiment establishes value.

Avoid a microservice rewrite, larger LLM, indiscriminate scraping, frequent polling of unchanged histories, unsupported injury feeds and uncalibrated "value" scores. Maintain the existing strict contracts, owner authorization, missing-data disclosure, source separation and safe Telegram pacing.

Business ROI should be measured as manual time saved, research coverage and verified error reduction against engineering/operations cost. There is no measured financial ROI or forecast edge in this audit.

## Verification boundary

Inspected relevant source, tests/documentation inventory, current repository status and official source pages. No current build/test suite or live application scrape was run: this is a design/research change only. Production deployment state, complete provider coverage, source permissions and real-world reliability were not audited. See `research-source-opportunities.md` for seven primary-source findings and limitations.
