# Bot player detection: product and reliability review

Date: 2026-09-30. Status: analysis and proposed backlog only; no implementation authorized.

## Executive decision

Improve **verified player coverage**, not the number of guesses or websites fetched. Preserve the existing commands, statistics definitions, provider selection, ownership rules, report formats and delivery behavior. Identity discovery and statistics retrieval are different capabilities: an official roster can establish that someone exists without providing their last ten matches.

The highest-return order is:

1. Close identity-collision and wrong-history acceptance gaps.
2. Measure where detection actually fails, by MODUS/PDC and pipeline stage.
3. Refresh and validate the existing directory; reuse verified source identities.
4. Add bounded, source-specific identity discovery on misses.
5. Evaluate additional statistics providers separately, only with explicit approval.

No code, configuration, data index, dependencies or production settings were edited for this review. Two analysis documents are the deliverables. No Telegram smoke-send, index refresh, commit, push or deployment was performed.

## Scope and evidence

Reviewed the runtime composition, Telegram routing, player and fixture resolvers, MODUS fixture/results/history services, PDC fixture discovery/reconciliation/history orchestration, DartsOrakel transport/scraping/parsing, odds identity and value joins, snapshots, statistics, report deadlines, representative tests and existing architecture/incident notes. This is a source-based audit of the principal workflows, not a claim to have read every line or measured production availability.

- `npm run build`: passed.
- `npm test -- --maxWorkers=2 --minWorkers=1`: 577 tests passed across 62 files. The sandbox attempt could not spawn workers (`EPERM`); the approved outside-sandbox run passed.
- Read-only in-memory probes reproduced the identity cases below. No test fixtures or implementation files were changed.
- Primary-source research and limitations: [source research](player-detection-source-research-2026-09-30.md).
- Existing incident history is useful context, not a fresh verification of the deployed build: `docs/PLAYER_IDENTITY_VERIFICATION.md`.
- `git status` was blocked by Git's repository-ownership check. No Git trust settings were changed; a clean working tree is not asserted.

## 1. What the product currently does

| User journey | Discovery / identity | Statistics / fallback contract |
|---|---|---|
| Telegram player last-N request, unqualified | DartsOrakel stats directory; exact, token-phrase partial, then conservative fuzzy matching | DartsOrakel completed history; `auto` is not provider failover |
| Explicit `from MODUS` | Official bundled + live MODUS catalogue, full-name/unique abbreviation matching | Official MODUS match details and averages only; no silent DartsOrakel fallback |
| `/modus` and daily report | Official daily feed, then Darts Nerd; fixture resolver also depends on DartsOrakel | Latest DartsOrakel form, not an official MODUS-only sample; player buttons retain that contract |
| `/pdc today` / `/pdc tomorrow` | PDPA event schedule, optionally reconciled with Darts Nerd; fixture names use DartsOrakel directory | Latest DartsOrakel history for discovered participants |
| `/pdc latest` | Completed DartsOrakel tournament calendar/results | Separate from upcoming fixture discovery |
| `/odds` | Eredmenyek browser collection | Odds observation; not a statistics-provider fallback |
| `/value` | Directory plus exact Eredmenyek event/date/profile identity evidence | DartsOrakel history; verified source profile alone does not remove the directory dependency |
| Local chat / agent / CLI | Shared deterministic services; local fast path recognizes full-name mentions; unmatched chat can use bounded Ollama tools | Different transport/composition from Telegram; Telegram itself is deterministic, not an LLM bot |
| Watchlist | Offline contracts emphasize provider IDs and validated quotes | Not evidence of an enabled live monitoring product; do not expand it as part of this work |

Evidence: `src/telegram/stats-service.ts`, `src/telegram/query.ts`, `src/daily/modus-report.ts`, `src/telegram/modus-player-callback.ts`, `src/pdc/default.ts`, `src/pdc/service.ts`, `src/value/reader.ts`, `src/agent/factory.ts`, `src/services/fast-research.ts`, `src/watchlist/identity.ts`.

### Strengths to retain

- Typed schemas, deterministic retrieval/calculation and explicit source boundaries.
- Official MODUS event/date/detail cross-checks; ambiguity is normally rejected.
- Odds verification preserves home/away slots and validates profile IDs instead of trusting URL order.
- Completed-match filtering, safe metric correlation, missing-data coverage and weighted checkout calculation.
- Partial report preservation, bounded concurrency/deadlines and Telegram retry policy.
- Owner-private-chat authorization before source work.
- Existing fuzzy/partial lookup and suggestions. These are already implemented, not new proposals.

## 2. Findings ranked by product risk

### A. MODUS country qualifiers collapse distinct labels — highest priority

`src/modus/identity.ts` removes parenthesized uppercase country qualifiers before generating the identity key. Both `Lee (ENG) Evans` and `Lee (WAL) Evans` become `lee evans`. The bundled official index contains these two labels and an unqualified `Lee Evans`.

`src/modus/player-history-service.ts` deduplicates catalogue identities and selects historical references using that key. Consequently the evidence distinguishing the labels is lost before ambiguity can be recognized. This is a concrete collision path, not merely an abbreviation problem. It is not proof of a particular incorrect production report.

**Proposed acceptance:** preserve country/source identity evidence independently of the display/search name. A qualified request must not retrieve the conflicting qualified player's history. An unqualified request remains unresolved if the identity cannot be uniquely established. Historical unqualified rows must not be retroactively assigned without evidence.

### B. The generic resolver lacks conflict quarantine present elsewhere

`src/player/resolver.ts` groups exact rows by normalized name without deduplicating identical IDs. Its partial/fuzzy candidate list instead deduplicates by ID with last-row-wins behavior. `FixtureNameResolver` and the value directory already have stronger conflicting-ID safeguards.

Read-only synthetic probes:

- Two identical rows for ID 3 / `John Same` produce `PlayerAmbiguousError` rather than one identity.
- ID 2 attached to `John Alpha` and `James Beta` resolves both exact names to the same ID.

**Proposed acceptance:** deduplicate identical identity evidence; quarantine contradictory ID/name claims consistently across pathways; never let response order decide identity. A same-name/different-ID collision remains ambiguous.

### C. Fuzzy scores reward long full names when comparing short token windows

The generic resolver computes edit distance against full names and token windows, but divides by the full candidate-name length. A short weak match can receive a high score because unrelated given names lengthen the denominator.

Probe: the invented five-character query `abcez` resolved to invented `Alexander Bartholomew Abcdx`, despite two edits in the five-character surname. This demonstrates scoring mechanics, not observed real-player misidentification.

**Proposed acceptance:** evaluate confidence against the representation actually compared; benchmark short surnames and compound names; retain deterministic suggestions/abstention. Do not simply lower the 0.86 threshold or increase edit distance. User-input typo recovery and machine-generated fixture identity should have different evidence requirements.

### D. Parsed match rows do not prove membership of the requested player

`src/dartsorakel/parser.ts` validates positive winner/loser IDs and uses them for match correlation, but does not require the requested ID to equal either participant ID.

Probe: parsing a fixture row with winner 3038 / loser 13 for unrelated synthetic requested ID 999999999 accepted one match. Under normal conditions the provider endpoint is expected to scope rows; the client currently relies on that upstream behavior.

**Proposed acceptance:** completed match rows must include the requested player in exactly one participant slot. Contradictory identity/result evidence must fail explicitly, not be assigned to the requested name.

### E. Multiple fixture sources still share one identity bottleneck

`PlayerResolver`, `FixtureNameResolver` and `DartsOrakelPlayerDirectory` all build from `getPlayerStats()`. Adding another fixture site does not automatically find a missing DartsOrakel identity or restore unavailable DartsOrakel statistics.

Directory promises can remain valid for the service instance's lifetime with no resolver-level TTL or refresh-on-miss. This matters in long-lived chat processes and warm serverless instances. The directory schema exposes `recordsTotal` / `recordsFiltered`, but loaders do not establish that the returned rows are a complete searchable catalogue. Truncation/pagination is an **unverified risk**, not a confirmed current upstream defect.

**Proposed acceptance:** record directory version/age/counts; validate provider count semantics; refresh once on a genuine miss; support pagination only if the provider's current contract demonstrates it; retain ambiguity across refreshes.

### F. MODUS fixture success is not necessarily completeness

`src/modus/service.ts` returns the first non-empty source, so an incomplete but non-empty result does not trigger corroboration. Returned player entries use `confidence: 1` even when Darts Nerd preserved an unresolved provider label. This value is not proof of verified identity.

The official fixture source resolves abbreviations with `Promise.all`; one failed abbreviation can invalidate that source attempt. Darts Nerd instead retains unresolved labels. The outer report has paired-fixture-to-roster fallback, but a non-empty paired slate does not establish that all players were discovered.

**Proposed acceptance:** distinguish source availability, fixture completeness and identity verification internally. Consult another source only for suspected gaps, without silently merging different dates/groups or replacing accepted official evidence. Preserving individual valid rows on failure needs approved partial-data semantics.

### G. PDC discovery and reconciliation have independent gaps

- `CorroboratedPdcFixtureSource` cannot rescue an empty or failed PDPA discovery with another official source; live rows are intentionally not standalone event authority.
- PDPA parsing depends on event cards, a ten-day start-date lookback and dated concrete matchups in particular content sections. A scheduled event without a parsed draw is not proof that no event exists.
- `bestLiveMatch` accepts one overlapping player and chooses the first best candidate when scores tie; the live parser does not establish a specific PDC event for each preview row. Same-day participation in another competition or repeated rounds needs stronger occurrence context. Existing docs describe uniqueness more strongly than this function enforces.
- Calendar tournament-name allowlists constrain completed-result coverage; new names and uncovered circuits should produce explicit coverage diagnostics rather than unsupported universal PDC claims.

**Proposed acceptance:** add a bounded PDC official event-page fallback for PDPA gaps; require event/date/round context and unique reconciliation evidence; do not admit unrelated fixtures solely through one common player. Preserve `/pdc latest` versus upcoming semantics.

### H. Transport and enrichment failures can masquerade as poor detection

Bulk clients pace at 3.2 seconds per request start; other service instances have different pacing. They all use the same Reader transport in deployed DartsOrakel workflows, but rate limiting is client-local. Multiple commands can collectively exceed a shared transport allowance. More sources/retries can therefore lower completion rather than improve it.

Enrichment uses `Promise.all` for average-related 180 and checkout responses. Failure of an enrichment request can fail a player whose identity and average history were available. That is not a player-not-found condition. Existing partial report preservation is valuable; do not duplicate it.

**Proposed acceptance:** stage-specific failure classification and measured shared pacing; bounded retries for transient failures only. Partial metric recovery could preserve existing coverage conventions, but changes current failure behavior and needs approval. No metric zero-filling, schema weakening or source-block bypass.

### I. Historical freshness, cache keys and cancellation deserve hardening

- Bundled MODUS index: generated `2026-08-16T15:39:24.552Z`, 16 series entries, 18,610 match references and 590 distinct display labels. Labels are not verified unique people. Live overlay already refreshes current/new weeks; it is wrong to claim all history is frozen at the bundle date. Previously known non-current weeks are not comprehensively revalidated on each request.
- MODUS detail promises cache by match ID without freshness TTL. Later upstream corrections may survive in a long-lived instance.
- MODUS history service does not accept/forward the caller signal although the source supports it; `waitWithSignal` stops waiting, but underlying catalogue/detail work may continue.
- History snapshots key on request spelling/count rather than canonical provider identity, and signal-bound cache misses are not seeded into the shared snapshot store. Repeated forms of the same request can duplicate work.
- Darts Nerd filters `data-utc` via date-string slicing while the product resolves today/tomorrow in Budapest. Midnight boundaries need contract tests before changing date interpretation.
- `findMentions` matches full canonical names only, unlike `resolvePlayer`'s partial/fuzzy path. This is an inconsistency in local-chat fast-path reach, not a Telegram parser defect.

**Proposed acceptance:** bounded freshness and refresh policy; provider-ID/version cache keys; cancellation propagation without poisoning shared requests; midnight and daylight-saving tests. Do not refresh or rewrite the committed index as part of this analysis.

## 3. Recommended detection waterfall

Future implementation proposal; **not active behavior**:

1. Preserve raw source label, source player/profile ID, event ID, date, group/round and qualifier evidence.
2. Try existing unique exact identity and previously verified provider crosswalk.
3. On a genuine not-found result, refresh the current directory once. On an outage, follow bounded transport recovery instead; do not misclassify it as absence.
4. For source-generated labels, inspect the same provider's exact event/detail/profile evidence first. For MODUS, use official current-week/catalogue context; for PDC, use official event draw/entries/player profiles.
5. Expand provider-specific abbreviation candidates within the verified event roster, then cross-check against the complete directory. Event context narrows candidates but must not erase conflicting identities.
6. Use evidence-backed aliases only: retain provider, URL, verified IDs, qualifiers, verification time and scope. Do not globally learn aliases from one spelling mismatch, generic country stripping, token reversal or an official-page typo.
7. Fetch the requested statistics only after identity is proven. If the DartsOrakel ID cannot be found, an official player identity can be internally known while DartsOrakel history stays unavailable.
8. Return unresolved/ambiguous/unavailable within current delivery deadlines. Never choose the famous player, arbitrary first candidate or model guess.

Each extra lookup must have a purpose, source allowlist, timeout, maximum attempts and remaining-budget check. Preserve completed cards and reserve delivery time. Do not crawl every site for every successful lookup. Providers mirroring one feed are not independent corroboration.

## 4. Source strategy without changing the statistics product

| Priority | Proposed use | Product boundary |
|---|---|---|
| First | Existing MODUS official catalogue/current-week/results/detail evidence | Extend identity discovery; maintain official-only explicit MODUS history |
| First | PDC official player profiles and event-specific draws/entries | Supplement PDPA and establish spelling/roster evidence; not a replacement for last-N DartsOrakel metrics |
| First | Existing PDPA calendar and event pages; tour-card roster as candidate evidence | Already used for fixtures; roster expansion needs validation and does not cover every qualifier |
| Next | Existing Darts Nerd event/profile evidence where accessible and verifiable | Useful bounded corroboration; not independent official event authority |
| Next | Existing Eredmenyek verified profiles/events for odds-origin players | Reuse source identity evidence without making source IDs equal to DartsOrakel IDs |
| Feasibility only | Officially linked DartConnect event coverage | Verify public access, IDs, event coverage, rights and metric semantics before integration; no assumed free supported API |
| Later, separate decision | Additional commercial statistics APIs | Evaluate cost/licensing/coverage if measured unresolved cases justify it; no purchase or infrastructure change authorized |

Primary pages, exact URLs and access caveats are in the accompanying [research document](player-detection-source-research-2026-09-30.md). More sources should address measured missing-player cohorts, not duplicate established coverage.

## 5. Delivery roadmap and acceptance gates

All phases below require a later implementation request.

| Phase | Bounded scope | Completion evidence |
|---|---|---|
| 0: baseline | Curated identity gold set; stage/failure/source telemetry; unchanged-output characterization | Reviewed labels and source evidence; MODUS/PDC/odds cohorts reported separately |
| 1: safety | Qualifier collisions, conflicting/duplicate IDs, fuzzy scoring calibration, requested-player membership | Regression probes become tests; zero false joins in adversarial gold set; successful valid exact cases unchanged |
| 2: coverage | Directory freshness/completeness validation, refresh-on-miss, verified aliases/crosswalk, identity-key cache reuse | Additional correctly resolved players with traceable evidence; ambiguous identities still abstain; bounded added requests |
| 3: source resilience | Official PDC event fallback; MODUS gap corroboration; cancellation/deadline and shared-pacing improvements | Outage/partial-slate/replacement tests; no unrelated fixture admission; p95 latency and delivery completion do not regress materially |
| 4: optional metrics resilience | Same-provider partial enrichment; separately evaluate new history providers | Explicitly approved failure/source behavior and truthful coverage labels; no mixed or fabricated metrics |

Relative effort: safety fixes and measurement are small-to-medium; robust provider crosswalks and source adapters are medium; durable scheduling/shared infrastructure and new statistics providers are larger and not first-line work. Numeric cost or delivery dates are not estimated without production-volume and licensing evidence.

### KPI scorecard

Do not announce a detection percentage before collecting a baseline.

- **Verified identity recall:** correctly resolved eligible fixture slots / independently labelled eligible slots, separated by MODUS/PDC, qualifiers/new entrants, abbreviations and full names.
- **Precision / false joins:** incorrect accepted identities / accepted identities. Zero observed on the test set is a release gate, not proof of universal accuracy.
- **Fixture completeness:** discovered concrete pairs / official reviewed pairs. Keep not-yet-published draws distinct from empty schedules.
- **History success conditional on identity:** players with usable requested-provider history / verified players.
- **Metric coverage:** actual/requested completed rows and available average/180/checkout rows separately.
- **Fallback yield:** newly correct resolutions per extra request, by adapter and failure reason.
- **Operational quality:** p50/p95 latency, source requests per player, 429/timeouts, unstarted players, partial reports and confirmed final delivery.

Suggested rollout gate: zero identity regressions on the reviewed benchmark; retain all previously valid fixture cards; demonstrate incremental verified recall on a fixed missed-player cohort; cap request growth and remain within existing command budgets. Numerical recall/latency targets should be agreed after baseline measurement, not invented now.

### Regression matrix

Cover country-qualified homonyms, unqualified historical labels, same-name/different-ID, same-ID/different-name, identical duplicates, juniors/seniors, accents/apostrophes, compound surnames/initials, source-specific reversed display names, short typo false positives, missing directory entries, directory truncation, stale aliases, withdrawals/replacements, two same-day events sharing a player, unpublished draws, partial non-empty feeds, 403/429/5xx, hanging bodies, cancellation, individual failed details, enrichment-only failures, Budapest midnight and daylight-saving boundaries.

Golden tests must also preserve existing source routing, mean-of-match averages, weighted checkout, complete-only 180 totals, report counts/order, owner authorization, callback semantics and no model inference of identity.

## 6. Explicit approval boundary

Identity recovery may change a formerly failed lookup into a correct success; safety fixes may change a previously guessed success into abstention. Thus it is impossible to promise byte-for-byte identical outcomes while improving detection. The correct invariant is **unchanged feature semantics**, with individually approved correctness/reliability improvements.

Remain outside this strengthening scope unless separately approved:

- Switching unqualified requests, `/modus`, `/pdc` or `/value` to another statistics provider.
- Mixing official MODUS-only history with cross-event DartsOrakel last-N samples.
- Adding 180/checkout metrics to official MODUS output, or changing any aggregate definition.
- New commands, clarification buttons, report layouts, public users or prediction/betting automation.
- New paid accounts, database/queue/Redis infrastructure, persistent personal-data collection or source-access bypasses.
- Raising function/deadline limits instead of reducing unnecessary work.

## Bottom line

The bot already has substantial safety and fallback infrastructure. Strengthen its weakest identity boundaries, then make fallback **contextual, measurable and bounded**. More official identity evidence is worthwhile; silently changing the statistics source is not. Production logs and a reviewed missed-player sample are the next evidence needed to choose between freshness, alias, roster and transport work.
