# Research automation package: implementation plan

Date: 2026-10-06, Europe/Budapest. Status: implementation authorized by the subsequent user request and completed within the local/on-demand boundary. Scheduling, production rollout and publishing remain outside this task.

Implementation closeout: TypeScript, 744 tests across 81 files, both synthetic benchmarks, and the production dependency audit (zero reported vulnerabilities) passed. See `RESEARCH_AUTOMATION_PACKAGE_WALKTHROUGH.md` for the decisions, compatibility approach and limits. PDC's existing four-way collection was retained after the serial strategy failed a synthetic yield gate; no production strategy rollout was necessary.

Scope: recommended package #1 quality assessment, #2 deadline-aware collection, #3 fixture-derived participants, #5 missing-data diagnostics, #8 automated verification. This is an extension of the first delivery, not a replacement for it or implementation of the predictive second delivery.

## 1. Executive decision

Post-implementation review on 2026-10-06: see `RESEARCH_AUTOMATION_PACKAGE_REVIEW.md`.
The hardened implementation passed 754 tests across 81 files, TypeScript, both
benchmarks and the production audit. Warm-first planning remains process-memory-only;
disk reuse is evaluated during acquisition, not a global scheduling guarantee.

Keep the existing strict TypeScript modular monolith, source adapters, history service, ledger, cancellation helpers and authorized report paths. Add small pure assessment/planning functions and a thin execution coordinator. No runtime dependency, database, queue product, microservice, larger LLM or new cron is required for this package.

Deliver automatic preparation and consistent quality explanations inside existing workflows. A new unattended service is out of scope. Expected ROI is less manual participant preparation, fewer redundant acquisitions, better partial reports and earlier detection of incorrect research. Financial ROI and improved live latency are hypotheses, not measured outcomes.

Apply practices documented by Google SRE and AWS: explicit correctness invariants, user-relevant measurements, bounded failure behavior, one retry owner and reversible rollout. Do not imitate their infrastructure scale or claim certification by a checklist.

### Defaults the implementer can decide without owner input

- Existing permitted public sources and owner-only access remain the boundary.
- Existing 60-second observation reuse policy remains unchanged; do not confuse it with provider freshness.
- Acquire at least 20 rows for ordinary 10/20-match research, retaining existing scope isolation.
- Existing batch ceiling is 100 participants. Reject oversize direct inputs; for fixture-derived overflow retain explicit excluded references, never silently truncate.
- Output order follows the fixture inventory; execution order may differ and must be explainable.
- Local storage remains explicitly opt-in and rejected on serverless. Interactive memory-only research stays supported.
- No manual ranking, statistical confidence threshold or preferred-player list is needed.
- Optional capabilities remain additive and absent for legacy readers. No unsupported identity/freshness/completeness is manufactured.

## 2. Repository evidence and design constraints

Repository root for the file references below: `C:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper`.

| Inspected implementation | What exists | Consequence for this package |
|---|---|---|
| `src/research/history-service.ts` | Canonical identity, count/cutoff cache keys, 60-second reuse, shared cancellable acquisition, evidence quality metadata | Extend this service; do not create a second cache. Cached timestamps remain unchanged. |
| `src/research/statistics.ts` and `src/services/statistics.ts` | Disjoint windows, distribution summaries, metric counts and weighted checkout | Derive diagnostics from these counts or the same validated rows. Do not add competing arithmetic. |
| `src/research/collection-runner.ts` | Sequential local collection, checksummed v1 checkpoints, 100-name maximum, default 220-second budget | Extend checkpoint handling and budget coverage. Currently the timer starts after checkpoint load/resume checks; include preflight in the new end-to-end budget. |
| `src/pdc/service.ts` | Fixture/name deduplication, partial callbacks, four-way research concurrency; fixture retrieval is private | Expose a small validated fixtures-only API, not a call to the full upcoming report to discover participants. Do not assume serial execution beats the existing concurrency. |
| `src/modus/service.ts` and fixture schemas | Fixtures-only API; provider-specific source fields and date-only/optional start times | Normalize through narrow adapters. Preserve provider evidence and unknown start times. |
| `src/telegram/stats-service.ts` | Shared interactive/bulk history reader; official MODUS history is separate | Propagate additive assessment fields without mixing source identities or forcing DartsOrakel metadata onto official history. |
| `src/daily/report-budget.ts` | Research/total budgets and races for non-cooperative dependencies | Reuse cancellation patterns; keep delivery reserve separate and do not extend deployment timeouts. |
| `.github/workflows/ci.yml` | Node 24, locked installation, build, tests and production dependency audit | Extend existing CI rather than build another pipeline. Keep read-only permissions and no production secrets. |

Historical first-delivery verification was 679 tests across 73 files. That is a previous result, not a fresh test run for this plan. Existing synthetic 32-player modeling implies 96 statistic views and a 304-second launch span at 3.2-second spacing, before other overhead. This establishes capacity pressure, not a live benchmark or precise admission estimate.

## 3. Architecture and ownership

```text
existing fixtures or explicit local fixture discovery
    -> provider-specific validated adapters
    -> fixture inventory + unresolved/excluded references
    -> canonical identity resolution and participant deduplication
    -> bounded plan (reuse candidates / acquisition candidates)
    -> existing history reader and local checkpoint coordinator
    -> shared quality assessment + metric coverage diagnostics
    -> existing deterministic summaries/briefs/formatters

offline fixtures + retained evidence -> deterministic replay/verification
```

- **Provider adapters:** own source observations, identity evidence and provenance. A fixture name is a claim, not a canonical ID.
- **History service:** owns valid snapshots, cutoff/scope/freshness reuse and acquisition sharing.
- **Quality evaluator:** owns versioned assessment/reason codes, not match arithmetic or network calls.
- **Coverage evaluator:** owns metric denominators and gap facts, not predictive confidence.
- **Planner/coordinator:** owns bounded work order, remaining budget and per-participant outcomes, not transport retries or Telegram delivery.
- **Ledger/checkpoints:** retain original evidence and resumable local state. Process memory is not hosted durable storage.
- **Formatters:** explain assessments with bounded, sanitized text. They cannot override eligibility.
- **Verification command:** owns reproducible check orchestration, not live source validation.

Prefer functions and typed records. Introduce an interface only at a real clock, source, storage or cancellation boundary. Do not add an abstract workflow engine or a general-purpose rule DSL.

## 4. Non-negotiable guardrails

1. Preserve server-side owner authorization, approved HTTPS transports, source separation and existing send/retry semantics.
2. Validate external fixtures, stored packets, checkpoints and CLI inputs. Bound input files, arrays, output size, active work and stored records.
3. Reject malformed/tampered evidence, identity disagreement and future completed results. Never convert a failure into an empty successful result.
4. Separate valid-but-limited evidence from invalid evidence. Unknown format, incomplete coverage or zero checkout attempts does not invalidate unrelated valid averages.
5. Observation age and provider-update freshness are separate fields. Unknown source-update time stays unknown.
6. No probabilities, value scores, advantage rankings, injury/motivation stories, inferred legs or zero-filled missing metrics.
7. No global quota/durability claims from process memory or local locks. Coordinate only the already-supported participating scope.
8. Transport owns existing retries. The coordinator does not retry an entire failed player acquisition inside the same run; explicit resume may retry failed work within a new bounded invocation.
9. Keep caller cancellation distinct from collection deadline. Caller cancellation stops new work and propagates; deadline returns explicitly partial work where the existing contract permits it.
10. Cancellation cannot undo an already-started filesystem operation or force a non-cooperative dependency to stop. Bound the caller wait, observe late failures and prevent late results from mutating returned state.
11. No secrets, raw response bodies, arbitrary exception messages or high-cardinality player labels in operational logs. Existing evidence retention remains private and bounded.
12. No automatic lock stealing, evidence deletion, checkpoint rewriting, live scrape, notification, deployment, commit or push as part of plan creation.

## 5. Contracts and decision rules

Names here are proposed contracts, not code already implemented. Export explicit parameter/return types, use `unknown` at untrusted boundaries, strict Zod schemas where persisted, and exhaustive discriminated unions. Never use TypeScript `any` or assertions to conceal uncertainty.

### QualityAssessment v1 (#1)

Separate packet validity from analysis limitations:

- `validity`: `valid | rejected`, with stable reason codes.
- Dimensions: identity, observation age, provider freshness, history scope, ordering, format, persistence.
- Per-operation eligibility: available, limited or unavailable for scoring comparison, weighted checkout comparison and chronological trend comparison.
- Rejected packets produce no research metrics. Valid packets can still contain unavailable operations.
- Absence of evidence metadata from a legacy reader means unknown, not rejected or canonical.
- Empty history is an explicit no-data outcome; no arithmetic runs on it.

Ordering policy:

- Detect date-order inconsistency and duplicate provider-composite identities. Do not silently sort or drop rows to make them appear correct.
- Chronological trend is unavailable for inconsistent order or unresolved duplicate identity.
- Date-only ties crossing the latest-ten/previous-ten boundary make that chronological trend unavailable; individual source-order summaries may remain visible with a limitation.
- Ties contained within a window are disclosed, not treated as proof all metrics are unusable.
- A valid immutable archive may be replayed when old, but must be labeled replay, not fresh current research. No new stale fallback is introduced.

### CoverageDiagnostics v1 (#5)

For the displayed scope and, separately, each analytical window, report:

- Requested and observed row counts; available averages and 180 counts.
- Checkout rows with positive attempts, total hits and attempts; zero-attempt rows separate from missing denominators.
- Explicit-leg paired rows, sum of legs and paired 180s; no score-derived denominators.
- Missing counts and stable gap codes; nullable proportions when denominator is zero.
- Known observation age and unknown provider-update freshness/context/completeness.

Coverage proportions describe these observed rows, not all matches in a calendar period. Twenty returned matches does not prove the provider query is complete. Do not merge these dimensions into a 0-100 quality score. Reconcile all displayed values with the same summary input.

### FixtureResearchInventory v1 (#3)

- Source/date/fixture occurrence references, original names and nullable start times.
- Canonical participant IDs after resolution, alias references and fixtures involving each participant.
- Unresolved, conflicting, placeholder and overflow references with stable reasons.
- Namespace IDs by provider. Never compare an official MODUS source ID with a DartsOrakel ID as if they were interchangeable.
- Preserve every fixture reference even when two aliases collapse to one participant. Same normalized name alone is not sufficient proof of canonical equivalence.
- Different events/rematches are not collapsed by player pair alone. Replacements change inventory identity; old local checkpoints cannot silently apply to a changed inventory.

### CollectionPlan / CollectionOutcome v1 (#2)

- Stable inventory index, canonical participant reference, requested scope, fixture references and plan action.
- Plan actions: eligible reuse candidate, acquire candidate or unresolved/excluded. Recheck freshness and identity immediately before reuse.
- Outcomes: complete, failed, deferred-deadline, unresolved, excluded-limit; caller cancellation is propagated separately.
- Complete means valid acquired/reused data, not complete 20-row statistics. Local checkpoint success additionally requires confirmed local persistence.
- Keep acquired success with persistence failure visible to interactive callers; local resumable collection cannot mark it durably complete.
- Every inventory reference maps to one terminal participant outcome or an explicit unresolved/excluded reference. Counts must reconcile.

## 6. Step-by-step implementation

### Step 0 — Record baseline and lock scope

1. Inspect working tree and applicable instructions; preserve unrelated work.
2. Run current typecheck/tests and reuse benchmark. Record actual versions, counts, platform and failures.
3. Capture small golden fixtures for compare, value, PDC and MODUS output, including partial/failure paths.
4. Write acceptance cases before changing factories. Do not alter runtime/dependency versions or `vercel.json`.

**Exit:** baseline evidence recorded; unrelated failures distinguished; no live smoke script run.

### Step 1 — Build the shared quality evaluator (#1)

1. Add `src/research/quality.ts` and a small versioned contract alongside it.
2. Implement pure assessment using validated rows, optional evidence metadata, requested scope and an injected clock/policy.
3. Reuse existing integrity validation rather than duplicating content hashing. Centralize ordering assessment now scattered between history metadata and summary warnings.
4. Add an additive assessment field to research reads; preserve old evidence packets and readers.
5. Use stable reason codes internally and human wording only at presentation boundaries.

**Tests:** corrupt hash, identity conflict, future evidence, invalid clock, no evidence metadata, empty rows, date ties inside/across windows, inconsistent order and duplicate IDs. Test a legitimate zero value separately from missing values.

**Exit:** deterministic assessments; invalid evidence never reaches arithmetic; partial metrics remain usable where justified.

### Step 2 — Build reconciled coverage diagnostics (#5)

1. Add `src/research/coverage.ts`; derive counts from exactly the same rows as existing summaries.
2. Add displayed-scope and analytical-window coverage without confusing visible last-ten rows with acquired last-twenty rows.
3. Report zero attempts, absent attempts and valid positive denominators separately.
4. Reconcile weighted checkout and paired-leg statistics against existing functions. Do not change their rounding rules.
5. Feed structured gap codes to the brief and model tool contracts; no additional source calls.

**Tests:** 0/1/9/10/19/20 rows, legitimate zero averages/180s, missing metrics, unequal checkout attempts, zero attempts, partial legs, all-empty metrics and mismatched requested/acquired scope.

**Exit:** no NaN/Infinity/divide-by-zero; count identities hold; diagnostics never imply population completeness.

### Step 3 — Generate participant inventory from existing fixtures (#3)

1. Add `src/research/fixture-inventory.ts` with pure PDC and MODUS adapters.
2. Expose `getFixturesForDate` on PDC service by wrapping its existing validated/cache-backed fixtures path; do not invoke player enrichment to discover fixtures. Reuse MODUS `getModusFixtures`.
3. Convert fixtures to source-specific inventory records. Preserve date, occurrence ID, original names, source links and optional start times.
4. Resolve names through existing trusted resolvers under the same budget. Share canonical resolution between inventory and acquisition; do not force a second directory request.
5. Deduplicate by resolved provider identity; preserve all aliases/fixture references. Ambiguous/unresolved names stay explicit.
6. Add an explicit CLI fixture-discovery path, proposed `research collect-fixtures --source pdc|modus --date YYYY-MM-DD --run-label LABEL`. Local retention remains required for collection.
7. Support offline inventory tests from fixture files. Online discovery happens only through an explicitly invoked collection/report path, never during validation or plan inspection.

**Tests:** repeated participants, two aliases/one ID, same-name conflicts, TBD placeholders, cancelled/replaced fixtures as supported by source contracts, unknown times, date mismatch, rematches, empty inventory, overflow and malformed source URLs.

**Exit:** participant lists need no hand-authored names; no guessed identity; original fixtures remain fully accountable.

### Step 4 — Add bounded collection planning (#2)

1. Add `src/research/collection-plan.ts` for pure planning and extend the existing coordinator rather than creating another runner.
2. Add a non-fetching lookup for already-resolved fresh history candidates. Inspection cannot secretly scrape; misses remain acquire candidates. Actual reuse revalidates cutoff, scope, identity and TTL.
3. Serve eligible warm candidates first. Cold work uses earliest known upcoming start, then stable inventory order for ties/unknown times. This is scheduling priority, not an analytical ranking.
4. Keep local cold acquisition sequential initially, matching the current runner. For PDC compare the existing concurrency of four with serial cold admission under identical paced synthetic transport. Do not change production concurrency until correctness and representative complete/partial yields justify it.
5. Start a single end-to-end budget before checkpoint reads, resume verification, fixture discovery and identity resolution. Use monotonic elapsed time for deadlines and wall clock for observation dates. Respect any earlier enclosing report deadline.
6. Default local total remains 220 seconds (existing upper configuration bound 300 seconds). Reserve a configurable 5 seconds for final persistence/output inside the budget; this is an operational policy, not a measured guarantee. Do not borrow report delivery reserve.
7. Stop admitting new acquisition at the remaining-budget boundary. Estimate the three-view request cost for diagnostics only; do not reject work based on an unmeasured predicted latency. No increased concurrency or extra retry layer.
8. Race non-cooperative source/ledger operations; stop publishing late results. Completed durable rows remain restartable, deferred rows remain explicit, caller cancellation propagates. A slow synchronous filesystem call cannot be hard-preempted; document this limitation.
9. Keep resume as resume: completed old evidence retains its time. A new run label/inventory creates a new collection, not a silent refresh of completed rows.

**Tests:** no work admitted after deadline, warm item expires while queued, slow resolution, stalled source/body/storage, cancellation before/during preflight/acquisition/final write, alias sharing, deadline partials, write failure and cross-day cutoff.

**Exit:** all inventory references accounted for; valid partial progress retained; no deadline reset at each phase; no hidden refresh or late state mutation.

### Step 5 — Integrate reports without changing delivery

1. Propagate additive quality/coverage fields through stats, PDC and MODUS research contracts where actual evidence supports them.
2. Wire compare/value/paired cards and model tools to the same evaluator outputs. Preserve official MODUS source boundaries and legacy reader compatibility.
3. Show compact facts: observed rows, valid denominators, observation age if known, material limits and missing evidence. Keep details on demand and source inventory complete.
4. Suppress ineligible chronological trend claims while retaining eligible source-order descriptive summaries. Avoid duplicating every warning in multiple sections.
5. Preserve owner checks, pagination, message limits, source order and existing confirmed/uncertain-send behavior.

**Tests:** real factories with mocked network, source routing, stale/unknown evidence, contrary metrics, legacy reader, hostile names/URLs, message bounds, partial callbacks and unauthorized commands making zero source calls.

**Exit:** real consumers use the new functions; no helper-only delivery, new endpoint or notification side effect.

### Step 6 — Preserve local checkpoint compatibility

1. If new inventory/outcome fields require a checkpoint change, introduce v2 in a separate versioned filename namespace. Keep v1 readers and files intact.
2. Validate imported v1 evidence association and original timestamps. Explicit v1-to-v2 import writes a new record; no in-place migration or automatic freshness restamp.
3. Include immutable inventory identity, source namespace, scope and alias associations in v2 checksum validation. Fail on changed run input or replacement fixtures.
4. Retain existing exclusive locks, atomic synced writes, size/count bounds and serverless rejection. No automatic deletion or abandoned-lock takeover.

**Tests:** v1 resume, v2 resume, input changed under same label, corrupt association, concurrent collection, missing evidence, interrupted write and rollback to the v1 path.

**Exit:** old evidence remains readable and old CLI resume remains supported; rollback does not destroy new records.

### Step 7 — Automate verification (#8)

1. Add a dependency-free Node/TypeScript verification orchestrator and proposed `npm run verify:research`.
2. Run build, full tests and synthetic/replay assertions; fail fast with actionable stage/exit information. Run production audit separately so vulnerability findings and registry outages are not mistaken for research logic failures.
3. Use fixed clocks or version-supported Vitest fake timers; restore globals/timers after each test. A system-time change alone does not advance timers.
4. Make replay tests disable source access and assert no Telegram calls. Use synthetic data or scrubbed permitted fixtures, not private ledger artifacts in CI.
5. Exercise 4/16/32-player cold/warm/mixed slates with paced mock transport, deadlines and failures. Compare current and proposed execution strategies; count actual mocked calls rather than only extrapolating them.
6. Extend existing GitHub Actions job to call the same verification command and existing audit once. Keep locked dependencies, Node 24, read-only permissions and no deployment credentials.
7. Use a unique workspace temp directory for the verifier when needed; scope TEMP/TMP to child processes. Clean only directories created by that invocation after checking they are inside the intended workspace. Never delete the whole shared `.tmp`.

**Exit:** local and CI checks are reproducible; changed date/time/platform cannot silently weaken assertions; no live network/source fixture tests run by default.

### Step 8 — Review, shadow and handoff

1. Review final diff for scope, strict types, secrets, cancellation, source trust, persisted-schema compatibility and formatter bounds.
2. Run targeted checks, then complete verifier and audit; record actual command results and versions. Never claim tests that were not run.
3. Compare quality/planning outputs on offline representative reports before enabling changed report behavior. Old/new execution comparisons use independent mock budgets, not doubled live source requests.
4. Ship additive diagnostics first. Enable a changed collection strategy only after the experiment gate passes. New explicit local CLI paths do not imply a production rollout.
5. Preserve old execution behind a validated default-off rollout switch until accepted. Rollback disables changed planning; compatibility/authorization/integrity checks must never be bypassed to recover availability.
6. Document what changed, why, commands, limitations and recovery. No commit/push/deployment/schedule activation unless separately requested.

## 7. Acceptance matrix and proof obligations

| Requirement | Required proof |
|---|---|
| Invalid evidence produces no metrics | Hash/schema/identity/future canaries rejected in unit and integration tests |
| Limited evidence remains useful | Valid averages with missing checkout/legs still displayed with correct limitations |
| Canonical aliases do not duplicate history work | Alias fixture integration results in one acquisition per canonical scope |
| No missing inventory entries | Input-reference totals reconcile to completed/failed/deferred/unresolved/excluded outcomes |
| Planning does not hide network work | Pure planning and cache inspection make zero source calls |
| Refresh remains honest | Queue expiry triggers bounded acquisition or defer; timestamps never restamped |
| Boundaries have meaning | Preflight/source/persistence stalls finish caller wait within mocked total deadline; late results cannot publish |
| Cancellation isolation preserved | One subscriber cancels without poisoning another; all leaving signals upstream |
| Diagnostics agree with statistics | Independent hand-calculated fixtures match weighted/paired denominators and displayed scopes |
| Chronological claims safe | Inconsistent order, duplicate IDs and cross-window date ties suppress chronological trend |
| Existing access/delivery preserved | Unauthorized paths call no sources; no new sends; existing uncertain-send tests pass |
| Compatibility and rollback safe | v1 evidence/checkpoints and legacy readers pass; v2 records not rewritten/deleted |
| Verification is offline | Unexpected source/Telegram access fails tests; local temp cleanup cannot escape owned directory |

### Measurable ROI and release gates

- Hard correctness gate: all inventory accounting, identity, arithmetic and authorization tests pass. These are zero-tolerance invariants, not a claim of perfect real-world data.
- Call-efficiency gate: for valid warm same-scope histories, zero additional statistic-view requests; canonical aliases do not add acquisitions. Count identity/fixture requests separately.
- Planning gate: proposed policy must not reduce completed valid participants on representative deterministic 4/16/32 cold/warm/mixed cases versus the baseline. If serial PDC work regresses, retain existing bounded concurrency and adopt only justified improvements.
- Deadline gate: fake-clock tests show no new admission after stop, bounded caller completion and preserved partial outcomes. Do not use wall-clock millisecond assertions as cross-platform promises.
- Product gate: generated participant inventory equals supported source fixture participants without manual name entry; gaps are explicit and briefs remain within current output limits.
- Latency/coverage measurements: capture complete fraction, deferred/failed fraction, observation ages, reuse, actual source calls and end-to-end elapsed distribution. Do not publish a p95 SLO from tiny synthetic samples or claim live improvement before an approved live pilot.
- Runtime dependency gate: no new runtime dependency or production service. Unexpected dependency/schedule/storage changes stop the package review.

## 8. Risks, recovery and excluded work

| Failure/risk | Required safe behavior | Residual limit |
|---|---|---|
| Source unavailable or throttled | Existing transport retry policy; partial outcome, no coordinator retry storm | Source uptime and shared IP/account quota are external |
| Corrupt local evidence/checkpoint | Reject stored record; checkpoint association failure stops resume with recovery message | Do not auto-delete or silently substitute another player's evidence |
| Optional interactive persistence failure | Valid research may display with persistence-failed status | Cannot claim restart durability |
| Same-day temporal ambiguity | Suppress unsupported trend, retain labeled valid descriptive stats | Exact completion order remains unknown |
| Snapshot expires during planning | Recheck at use; acquire within budget or defer | A plan is not a freshness reservation |
| Process crash/abandoned lock | Preserve records; documented operator inspection before recovery | Local pilot is not automatic crash recovery or a backup service |
| Hanging dependency | Abort signal plus bounded caller race; observe late errors | Already-started non-cooperative I/O may continue |
| Formatter growth | Pagination/message tests; concise summary with details | Never drop inventory silently to fit one message |

Excluded: new cron/continuous monitoring, hosted shared storage, global quotas, Telegram feedback buttons, automatic archival/deletion, odds history, new richer-stat scraping, format inference, opponent-adjusted models, probabilities, wagering and guaranteed uptime/ROI.

Implementation engineer owns tests and recovery documentation; repository maintainer owns release review. Owner approval is required only for new production effects, storage/services, source access or spending, not ordinary conservative implementation choices. No new disaster-recovery SLA is claimed for this local/in-process extension.

## 9. Evidence-based decisions and original documentation

- **Measure user outcomes rather than collect every metric.** Google SRE recommends a small set of meaningful indicators and distinguishing measured behavior from objectives. Here that means complete research, correctness, latency and failures, not a fabricated five-nines promise. [Google SRE: service-level objectives](https://sre.google/sre-book/service-level-objectives/).
- **One retry owner and bounded end-to-end work.** AWS explains how retries amplify load and why timeout/backoff policy must account for dependencies. Here transport retains retries and the coordinator bounds the whole workflow. [AWS Builders Library: timeouts, retries and jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/).
- **Version-aware deterministic tests.** Context7 was used to resolve Vitest and query v3.2.4 documentation. It returned useful versioned timer guidance but also snippets from current main; those mixed-version CLI snippets were not treated as installed-v3 authority. Original Vitest v3 docs confirm the version-specific configuration. Keep the lockfile/runtime unchanged. [Vitest v3 configuration](https://v3.vitest.dev/config/), [v3.2.4 mocking documentation](https://github.com/vitest-dev/vitest/blob/v3.2.4/docs/guide/mocking.md).
- **Code evidence outranks speculative scale claims.** Existing factories, summary denominators, checkpoint semantics and report deadlines establish the smallest useful extension. No evidence currently justifies replacing them with distributed infrastructure.

These references support engineering choices; they do not prove predictive performance, legal permissions or production readiness. Recheck exact installed-library docs during implementation whenever an API decision is uncertain.

## 10. Definition of done

The package is implemented only when all five capabilities work through actual consumers, every acceptance row has test evidence, old evidence/checkpoints remain compatible, full checks pass or unrelated failures are explicitly reported, and the final walkthrough explains behavior and limitations. Design approval alone is not implementation completion.

Planning-stage verification: relevant source/contracts/CI and system-design guidance inspected; original docs checked with Context7 and direct primary sources. No implementation suite, live scrape or runtime benchmark was rerun during plan creation. The subsequent implementation verification is recorded at closeout above and in the walkthrough; it does not establish live provider performance.
