# First delivery: Feynman-style walkthrough

Date: 2026-10-05. Both delivery plans are written. First delivery is implemented as a local-first research layer plus safe in-process hosted improvements. Second delivery is a plan only.

## The simple mental model

- Previously, asking the same player question in different commands could send the librarian back to the same shelves repeatedly.
- Now, the librarian identifies the player, collects a bounded evidence packet, stamps when this research layer observed it, and reuses it for related questions.
- The packet is a receipt, not a prediction. It records exactly what the bot had, including what it did not know.
- Optional local storage keeps old receipts. A corrected result makes a new receipt; it does not secretly rewrite an earlier one.
- A summary calculator explains the packet. It never invents a probability or fills a missing metric with zero.
- A local checklist lets interrupted collection resume. Telegram remains on the existing authorized delivery path; the new collection command sends nothing.

## What changed, why, and the reasoning

### 1. Versioned evidence

- Added `src/research/evidence.ts` and `ledger.ts`.
- Each validated packet carries canonical player identity, matches, observation time, query cutoff/count, acquired count, parser version, source URL and a SHA-256 content ID.
- Warm reads/replay preserve the original observation stamp.
- Source update time and query completeness are explicitly unknown. The stamp means "normalized response observed by this research layer," not "provider updated at this instant."
- Match parsing preserves source event/tournament/opponent IDs, composite identity, profile URL and date-only precision. No exact completion time is manufactured.
- Optional explicit legs/darts denominator fields are validated but not scraped or inferred from scores.
- Why: later analysis needs traceable identities and honest timing. More advanced statistics cannot rescue mismatched or future evidence.
- Decision proof: correction/restart/hash/tampering tests verify earlier packets remain replayable, while altered content and future completed results are rejected.
- A content hash detects changed bytes; it is not proof the provider is correct or a digital signature authenticating a provider.

### 2. Canonical reusable acquisition

- Added `src/research/history-service.ts`.
- Resolve player identity before the history key. Related ten/twenty requests use the same acquired scope of at least twenty; larger scopes remain separate.
- Default observation TTL is 60 seconds. The key separates canonical player, Budapest query cutoff and acquired scope.
- Successful cancellable requests can populate reuse. One cancelled subscriber cannot poison another; when all consumers leave, the upstream signal is cancelled.
- Returned data is copied through validation so callers cannot mutate a cached evidence packet accidentally.
- Source/query errors do not silently become empty results. Optional storage failures preserve valid interactive research but label persistence failed.
- Why: there are three statistics views per player and limited source capacity. Reuse reduces actual acquisitions; adding workers does not create more quota.
- Decision proof: service tests cover aliases, 10->20, 20->10, concurrent subscribers, expired observations, day changes, wrong-player reuse, future/live data and caller mutation.
- Tradeoff: first-time interactive lookup now follows conservative shared Reader pacing and may be slower than the former isolated 250ms path. Warm research requires no new history acquisition within the freshness interval.

### 3. Connected to existing application paths

- Telegram interactive/compare/PDC/value factories share one canonical paced reader per process.
- Daily MODUS paired research and the local agent runtime also use the new history layer. Official MODUS historical statistics remain separate; they are not relabeled as DartsOrakel evidence.
- Local model tools receive optional structured evidence and richer summaries; numbers remain deterministic.
- Existing owner authorization, trusted transports, report deadlines and Telegram send/retry rules remain intact.
- Why: tested helpers alone do not improve the product; real consumers must use them.
- Decision proof: a network-mocked real-factory test exercises the actual resolver, scraper, transport wrapper and stats service. Interactive last-10 followed by bulk last-20 uses exactly four mocked HTTP calls: directory plus three views once. It preserves evidence ID/time and exposes the acquired previous-ten summary.

### 4. Comparable summaries

- Added `src/research/statistics.ts`.
- Latest ten and previous ten are disjoint. Existing last-10/last-20 outputs explicitly disclose their overlap.
- Added observed date span, median, sample standard deviation, and sensitivity when removing one highest/lowest observation.
- Checkout remains total hits divided by total valid attempts, not the mean of percentages.
- 180/leg uses only rows where the 180 count and explicit legs denominator are both known.
- Average labels say arithmetic mean of match averages, not pooled scoring average.
- Unknown format, missing data, same-day date-only ambiguity and inconsistent ordering remain visible.
- Why: a longer match gives more opportunities for 180s, a small checkout sample is unstable, and one exceptional score can dominate a mean.
- Decision proof: denominator/partial-data/disjoint-window/distribution fixtures exercise these cases. No current provider legs are invented, so live 180/leg may correctly remain unavailable.
- These are descriptive summaries; the sensitivity check does not diagnose an outlier or quantify win-probability uncertainty.

### 5. Briefs instead of false certainty

- Added `src/research/brief.ts`; integrated compare, value and PDC/MODUS paired output.
- Briefs lead with scoring/finishing differences, their samples, contrary evidence, missing facts and next useful evidence.
- Public "Confidence" labels now say "Data coverage." Legacy descriptive thresholds are disclosed as unvalidated, not probabilities.
- Standalone player evidence cards show optional evidence ID/time/persistence. Details and source links remain available.
- Why: stronger scoring and stronger finishing can point in opposite directions. A useful research assistant shows both, not just a favored name.
- Decision proof: contrary/partial evidence tests and adversarial pagination/sanitization tests pass. A normal expanded value card fits one Telegram page; multi-card inventories retain every matchup within message bounds.

### 6. Durable local workflow and feedback

- Added `collection-runner.ts`, `feedback.ts`, `local-files.ts`, `request-gate.ts` and `scripts/research-workflow.ts`.
- Explicit local collection uses a validated input file and per-player checkpoints. Completed evidence is resumed; failed/pending players remain visible.
- Checksums and canonical IDs guard checkpoint corruption/association. Resuming does not claim old observations are current; choose a new run label for a new collection.
- Replay and useful/not-useful/incorrect feedback are local only. Enumerated reasons avoid arbitrary secret-bearing notes.
- Atomic synced writes and exclusive locks avoid publishing half-written files. Abandoned locks are never automatically stolen.
- Same-workspace local Reader reservations coordinate participating processes at conservative spacing. They do not reserve a global IP/key allowance across unrelated processes or hosts.
- Why: filesystem primitives are enough for a bounded single-host pilot; a database/framework would add operational cost without a verified need at this boundary.
- Decision proof: disk restart, partial/deadline behavior, overlapping collection rejection, corrupted checkpoint, invalid feedback and reservation-state tests pass.

## Commands and operational guardrails

From the repository directory, explicitly enable local retention in the shell:

```powershell
$env:RESEARCH_LOCAL_LEDGER_ENABLED = 'true'
npm run research -- collect --input docs/research-batch.example.json
npm run research -- replay <evidence-id>
npm run research -- feedback <evidence-id> useful time-saved
npm run research:benchmark
```

- `collect` makes existing read-only public-source requests only when explicitly invoked. It does not create a schedule, send Telegram, log in to bookmakers, or place bets.
- `replay`/`feedback` do not query the source.
- `.env.local` is not automatically loaded; documentation does not enable retention or monitoring.
- Local retention is rejected on Vercel/Lambda. Hosted execution defaults to bounded memory evidence; it has no cross-instance restart guarantee.
- Fixed ignored directories: `.cache/research-evidence`, `.cache/research-workflow`, `.cache/research-control`.
- Default ledger limit: 1,000 records and 2 MB per record. Cold `latest()` lookup is linear in retained records; the pilot is deliberately bounded, not an unmeasured scalable database substitute.
- No automatic retention deletion. At capacity, archive deliberately after preserving needed evidence; write failures remain visible.
- Lock recovery requires confirming the original collector/writer stopped. Inspect `collection.lock`, `feedback.lock`, `reader.lock` and the ledger `.write-lock`; do not delete an active owner's lock.
- Keep local evidence private using OS/account permissions. POSIX file modes are best effort on Windows, not an ACL/security certification.

## Verification evidence

- TypeScript `npm run build`: passed.
- Final full regression: 679 tests across 73 files passed, including CLI configuration guards and real-factory integration with mocked network responses.
- Production dependency audit: zero reported vulnerabilities. No runtime dependency was added.
- Synthetic reuse benchmark: cold acquisitions were 4/16/32 for 4/16/32 players; warm and injected-ledger restart needed zero additional acquisitions in all scenarios.
- Those benchmark timings are mocked local processing, not real provider latency. The modeled cold launch spans are 35.2/150.4/304 seconds before directory/lookback/retry/response overhead.
- Independent read-only review identified an inconsistent-order label and factory-test gap; both were fixed and regression-tested. Review also led to record-size-proportional read buffers and conservative retention bounds.
- Baseline had a date-dependent future-result test and a temp-directory cache failure. The future test now uses a fixed clock. For sandboxed Windows verification, TEMP/TMP were pointed at the existing workspace `.tmp`; the cache test then passed unchanged.
- No new live provider scrape, real Telegram send, hosted deployment or source-permission audit was performed. Mocked contract tests prove behavior on supplied responses, not today's remote uptime or coverage.

## What remains intentionally outside this delivery

- Approved hosted transactional storage, cross-instance quota reservations, durable Telegram outbox/recovery and production scheduling.
- Telegram feedback buttons: feedback is a local CLI pilot until an approved durable hosted owner-feedback store exists.
- Automatic post-result invalidation/prewarming: this delivery uses bounded observation TTL and explicit collection, not a new live event monitor.
- Calendar-complete histories, per-match first-nine/throw splits and source-update timestamps: availability/contracts are not established; no aggregate is relabeled as last-ten match data.
- Second-delivery context adapters, opponent-adjusted baselines, odds ledger and chronological evaluation.
- Probabilities, value rankings, automated wagering and profitability claims.

The first-delivery plans and implementation therefore establish the safe local-first boundary, not a certification that unattended hosted research is fully durable. The next architectural decision is the approved hosted persistence/runtime target; it must be supported by measured source, quota, rights and deployment evidence.
