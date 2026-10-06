# Research automation package: Feynman walkthrough

Date: 2026-10-06, Europe/Budapest. Package #1 + #2 + #3 + #5 + #8 implemented in the existing local/in-process boundary. No live source scrape, new schedule, notification, deployment, Git commit or push was performed for this task.

## The mental model

Subsequent review: eight correctness fixes, two simplifications and clearer report
diagnostics passed **754 tests across 81 files**, TypeScript, both benchmarks and
the production audit. See `RESEARCH_AUTOMATION_PACKAGE_REVIEW.md` for counterexamples,
decisions and residual limits. The 744-test closeout below records the earlier implementation stage.

- The bot is a librarian, calculator and research checklist, not a fortune teller.
- Fixtures provide the reading list. Names are checked against the trusted directory before a history is attached.
- The librarian reuses eligible receipts, keeping their original timestamps.
- The calculator shows what the actual evidence supports. A missing checkout denominator does not invalidate an available average.
- The checklist stops when its time budget expires and tells you what did not finish.
- Automated verification checks the librarian and calculator with offline examples before we trust another change.

## 1. A shared quality assessment instead of scattered assumptions

- Added a versioned, pure quality evaluator with stable reason codes.
- Integrity/identity/future/invalid-record failures reject evidence before research arithmetic.
- Full receipts are checked against their supplied rows; a valid receipt cannot bless different statistics. Lightweight metadata is not mistaken for hash-authenticated evidence.
- Absence of legacy metadata means unknown, not canonical or invalid.
- Observation age, source timestamp presence, scope, ordering, format and persistence are separate dimensions. No combined confidence score is invented.
- Valid scoring can remain usable with missing finishing data or an incomplete prior window.
- **Why:** trust is a set of specific facts, not one impressive-looking percentage.

## 2. Chronology must be established, not guessed

- Centralized ordering inspection handles inconsistent dates, repeated provider composite identities and date-only ties.
- Latest-ten/previous-ten deltas and existing five-row matchup trends use their own window boundary checks.
- A same-day tie across the boundary suppresses a chronological change claim. Descriptive means stay visible and retain source order.
- Existing value research still performs its earlier completed/newest-first normalization. Quality inspects eligible source order first, discloses inconsistency and withholds unsupported trends; the transformation is not presented as proof of original chronology.
- **Why:** two matches dated the same day do not tell us which came first. Keeping averages is useful; asserting improvement from unknown order is not.

## 3. Coverage shows denominators and gaps

- Added diagnostics for displayed rows and each ten-row analytical window.
- Report available/missing averages and 180s, positive/zero/missing checkout attempts, and explicitly paired legs/180s.
- Reuse existing statistics calculations and rounding instead of maintaining a second formula implementation.
- Zero attempts, zero scores/counts and missing observations stay distinct. Empty ratios are null, not NaN or a misleading zero.
- Coverage describes observed rows; it does not certify that every match in a calendar period was collected.
- Integrated into history reads, player/compare/value reports, matchup analysis and model tools. Official MODUS data keeps its separate source boundary.
- **Why:** 50% checkout from two attempts and 50% from two hundred attempts have the same headline number but very different evidence.

## 4. Fixtures automatically become a participant checklist

- Added provider-specific validated inventory adapters and an explicit fixture-collection CLI.
- PDC exposes its existing fixtures-only service path; discovery does not call the expensive full research report.
- CLI fixture identity uses the existing strict fixture-name resolver and checks the resulting canonical directory ID/name before acquisition.
- Resolved aliases share one canonical participant. Every fixture/side reference is retained, including rematches, placeholders, unresolved names, identity conflicts and limit exclusions.
- Different labels resolving to the same player on both sides of a fixture are quarantined, not treated as a legitimate one-player match. The resume test originally used such an invalid dummy matchup; it was corrected to aliases across separate matches against a distinct opponent without weakening resume/integrity assertions.
- Fixture IDs and canonical DartsOrakel player IDs have separate namespaces.
- Inputs are bounded: 1,000 fixtures and 100 admitted canonical participants; overflow references are accounted for rather than silently dropped.
- **Why:** you should not have to type the player list twice, but spelling similarity alone cannot prove identity.

## Review fixes and workflow record

- Independent review found that a separately supplied owner signal could be ignored when an external budget was unlinked. Caller and deadline signals are now composed; both normal and externally supplied budgets preserve cancellation. The native API was checked against original [Node.js documentation](https://nodejs.org/docs/latest/api/globals.html#static-method-abortsignalanysignals) and the installed Node 24 runtime.
- Review also identified redundant directory loads. Fixture discovery and canonical identity extraction now share the same strict resolver/directory cache; identity extraction validates the profile host and ID rather than performing another generic name lookup. Tests prove one directory acquisition across discovery-style and history-identity resolution.
- Dependency sequence: quality/coverage contracts first, then independent fixture inventory and verification work with disjoint ownership, then root integration/review and full verification. Implementation delegates used GPT-6 Luna with xhigh reasoning.
- Worker setup exception: an initial delegate was interrupted and replaced to correct its model/fork configuration. Three child task records were therefore created, although only two contributed implementation and no more than two were active concurrently. This exceeded a strict two-total-record interpretation of the requested cap; it is recorded rather than presented as exact compliance.

## 5. One budget for the whole local workflow

- Added a monotonic collection budget separate from wall-clock evidence dates.
- Start the budget before input/preflight, fixture discovery, identity resolution and resume checks. Default total remains 220 seconds, bounded by 300 seconds; finalization reserves up to five seconds (smaller bounded reserve for tiny test/custom budgets).
- New fixture planning prefers eligible process-local reuse candidates, then known fixture start times, then stable inventory order.
- Cache inspection performs no resolver, source or ledger I/O. Actual use rechecks scope, identity, cutoff and freshness; planning does not reserve freshness.
- Existing transport retains retry ownership. The coordinator adds no retry storm.
- Source deadlines preserve explicit partial/deferred outcomes where feasible; caller cancellation propagates rather than masquerading as a provider failure.
- Already-started non-cooperative filesystem work can finish after the caller stops waiting. Its owner retains the lock until cleanup, and no lock is stolen.
- A resolution deadline returns its explicit inventory without freezing a partially resolved identity manifest. A later invocation can resolve again.
- **Why:** a stopwatch restarted after each phase is not an end-to-end deadline. A timeout cannot physically undo an already-started write.

## 6. Preserve restart history rather than migrate it unnecessarily

- New v2 manifests bind source/date/run label, raw fixture inventory, canonical associations, requested scope and stable execution order.
- They wrap unchanged v1 job checkpoints under a separate local namespace. No destructive migration or v1 import command was needed.
- Resume checks evidence against the verified canonical participant, not just a filename or stored ID claim.
- Completed rows resume with the same evidence identity/time, even when old; this is explicitly resume, not a freshness promise.
- Changed fixture/identity associations under an existing label reject safely. Use a new label for a new collection.
- Hashes/checksums detect alteration; they are not provider authentication or protection against an attacker with write access who can recompute them.
- **Why:** preserving known working storage contracts is safer and cheaper than rewriting old records just to add an inventory manifest.

## 7. The simpler concurrency proposal failed its gate

- Added a deterministic discrete-event benchmark with three mocked statistic views, shared 3.2-second launch spacing, an assumed five-second response latency and a 220-second deadline.
- It models the real dependency pattern: average first, then 180 and checkout enrichment can run concurrently.
- Nine cases cover 4/16/32-player cold, warm and mixed inventories. Mock call counts and outcomes are recorded, not claimed as live measurements.
- In the synthetic 32-player cold case, serial collection completed 16 participants versus 22 with four-way collection.
- Therefore PDC keeps its existing concurrency of four. Local checkpoint collection remains sequential as before. We did not add speculative production scheduling changes or another rollout flag for an unshipped strategy.
- **Why:** simpler code is a preference, not permission to reduce useful results. A counterexample is enough to reject an unproven blanket simplification; it does not establish live-provider performance.

## 8. One repeatable verification command

- `npm run verify:research` runs TypeScript, the full suite, replay checks in that suite and both synthetic benchmarks; a failed stage stops subsequent stages.
- Existing CI calls the same command, keeps Node 24/locked installation/read-only permissions, and runs the production audit separately once.
- Test setup rejects unmocked external fetches. Literal loopback addresses support local HTTP-server tests; redirects are rejected. Mocked provider and Telegram calls remain testable.
- This guard is not an OS-level network firewall or a guarantee covering arbitrary raw sockets/browser processes. CLI child-process tests use invalid inputs and do not perform positive live collection.
- The verifier uses a unique owned workspace temp directory, checks resolved containment before cleanup, and scopes TEMP/TMP/TMPDIR to its children.
- Date-dependent tests use fixed clocks; deadline tests advance controlled timers after the relevant operation starts, rather than trusting a flaky five-millisecond disk deadline.
- **Why:** verification must be reproducible, avoid external side effects, and explain exactly which stage failed.

## Commands: no background automation is activated

From `C:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper`:

```powershell
$env:RESEARCH_LOCAL_LEDGER_ENABLED = 'true'
npm run research -- collect-fixtures --source pdc --date 2026-10-06 --run-label pdc-20261006-a
npm run research -- collect-fixtures --source modus --date 2026-10-06 --run-label modus-20261006-a
npm run research -- replay <evidence-id>
npm run verify:research
npm run audit:prod
```

- Fixture collection reads public sources only when explicitly invoked. No Telegram messages, cron, provider account or bookmaker action is added.
- Local retention is opt-in and rejected on Vercel/Lambda. Hosted report improvements use existing memory behavior, not new cross-instance storage.
- Memory-only cache inspection is process-local. Disk restart reuse is evaluated by the history reader; it is not preflight warm prioritization across hosts.
- Recovery still requires confirming an owner stopped before handling an abandoned lock. No automatic evidence deletion or archival.

## Verification and remaining boundaries

- Baseline: 679 tests across 73 files passed; TypeScript and reuse benchmark passed.
- Final `npm run verify:research`: passed TypeScript, **744 tests across 81 files**, reuse benchmark, and all nine planning scenarios. Earlier partial/interrupted/failed verification runs were repaired and are not counted as success.
- `npm run audit:prod`: zero reported vulnerabilities. Diff/whitespace checks passed. Verification/test-owned temporary directories were cleaned; existing unrelated temporary directories were not removed.
- Planning benchmark: 396 invoked mock view calls across both strategies and nine cases; zero provider network calls/messages in the benchmark. Reuse benchmark warm/restart cases required zero extra acquisitions. Synthetic latency assumptions are not live measurements.
- No new runtime dependencies or lockfile changes; no changes to production cron configuration.
- No live fixture coverage, provider uptime, real latency, source-rights audit, hosting durability, model calibration or financial ROI claim is established.
- New planner execution is exercised by explicit local fixture collection. PDC concurrency/scheduling remains unchanged; shared quality/coverage is exercised by existing report paths.
- Outcome reconciliation, odds history, hosted durable jobs, Telegram feedback, automatic event refresh and calibrated prediction remain outside this package.

**What helps you now:** less manual list preparation, consistent explanations of missing evidence, safer chronology claims, accountable partial results and a repeatable safety check for future changes.
