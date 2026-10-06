# Research package review and hardening

## Follow-up: three small boundary fixes (2026-10-06)

Implemented recommendation #1 (preserve rejection), #2 (fallback identity check)
and #3 (storage/source failure classification). Exactly two GPT-6 Luna xhigh coding
agents worked in disjoint scopes; the main agent reviewed and verified integration.
The historical review below describes the preceding implementation stage.

| Fix | Implementation and reason | Tests |
|---|---|---|
| Preserve upstream rejection | Early guards in both player agent tools and the value reader stop rejected snapshots before arithmetic. Recomputing from otherwise valid rows must not erase an earlier identity/integrity rejection. Existing error/result shapes remain unchanged. | Both tools return only the fixed failure; value output has no windows, research or coverage even when evidence metadata is absent. |
| Verify fallback identity | Supply `expectedPlayerId: result.player.id` to the existing statistics fallback assessment. Reuse its identity-conflict rule rather than creating another validator. Existing full-scope precomputed assessments are not replaced with assessments of shorter displayed history. | Mismatched evidence ID rejects; matching ID succeeds; legacy missing metadata remains valid with unknown identity. |
| Distinguish receipt-read failures | Catch only the new-receipt ledger read. An ordinary read failure uses existing `PERSISTENCE_UNAVAILABLE`; owner cancellation propagates and deadline remains `DEADLINE`. Resume verification and checkpoint-write failures are not swallowed. | Real persisted receipt followed by a read failure; stalled-read deadline; cancellation during receipt verification without a checkpoint; existing source failure explicitly asserts `SOURCE_UNAVAILABLE`. |

Why this is the straightforward solution: simple guards and one narrow catch fix
the demonstrated boundaries without new dependencies, exception classes, retries,
storage schemas or generic policy machinery. Parent review also replaced a custom
50-iteration lock-cleanup polling helper with the existing Vitest `vi.waitFor`.

Verification: **762 tests across 81 files**, TypeScript and both offline benchmarks
passed. Eight new regression cases were added to the prior 754-test baseline.
Production audit reported zero vulnerabilities; no dependency changes were made.
No live scraping, messages, commit, push or deployment was performed.

This does not add global authentication of legacy metadata or validate prediction
accuracy. It enforces existing rejection/identity rules and makes recovery labels
accurate at the specific boundaries above.

---

Date: 2026-10-06. Scope: uncommitted changes against
`89896a559a9da52df618ba45a35cf535ea55c42a`, including new files. Requirements:
the package implementation plan and walkthrough. This is a local code review,
not a production certification or proof of predictive accuracy.

## Result in plain English

- A receipt must belong to the player and statistics being reported. Finding a file is not enough.
- Rejecting evidence must stop every derived statistic, not just the headline average.
- Conflicting identities must not share work or collapse into one collection job.
- Dates must exist on a calendar before we describe chronological patterns.
- Closing a budget must stop its consumers, not merely clear timers.
- Coverage rules now have one implementation, and diagnostics identify their player and comparison window.

## Standards

Two maintainability findings were addressed. These are engineering judgements,
not claims of certification against an external standard.

1. **Repeated coverage construction:** `diagnoseResearchCoverageScopes` in
   `src/research/coverage.ts` replaces four repeated constructions. The history
   service explicitly supplies its displayed slice while retaining acquired rows
   for the previous window. The default helper does not silently hide excess rows.
   The old history-service type import remains supported through a type re-export.
   **Reason:** one rule should not require four synchronized edits.
   **Evidence:** the coverage test checks distinct 90/80 window means, five
   displayed rows over twenty acquired rows, and excess-row disclosure.
2. **Manual cancellation forwarding:** compose the existing research/total/owner
   signals using native `AbortSignal.any`, already used by this package. Removed
   two forwarding controllers and manual listener registration/removal. Budget
   validation now belongs to the factory rather than a contradictory second
   one-millisecond runner check.
   **Reason:** fewer independently maintained lifecycle states, without another
   dependency or deadline reset. Closing preserves the report budget's abort
   semantics instead of disconnecting consumers first.
   **Evidence:** controlled-timer tests cover reserve separation, owner reasons,
   external-budget cancellation, close and timer cleanup.

Also removed the redundant head-to-head forwarding function while repairing its
call sites. Larger modules were not split merely for a line-count target: that
would add navigation without demonstrating a correctness or ownership gain.

## Spec

Eight correctness findings were addressed. Relevant plan invariants include
"Rejected packets produce no research metrics", rejecting "identity disagreement",
validating stored packets and bounded cancellation without unsafe late work.

| Counterexample | Smallest complete repair | Regression evidence |
|---|---|---|
| Same numeric player ID, conflicting profile slug: the second request joined the first flight. | Store the validated identity on the flight; reject conflicting name/slug before subscribing, without another request. | `research-history.test.ts`: conflict rejects, legitimate request succeeds, one scrape. |
| Alice's collection could be marked complete using Bob's existing receipt, or a same-player receipt with different rows/insufficient requested scope. | Bind receipt ID, identity, scope and rows before checkpoint success; reuse full-snapshot quality/hash validation. | `research-workflow.test.ts`: identity, row and scope mismatches fail without evidence association; normal resume still passes. |
| Metadata-only quality accepted `2026-02-30`: Match validation checked shape, not calendar existence. | Reuse the existing strict calendar schema at the research quality boundary. | `research-quality.test.ts`: impossible date rejected, comparison unavailable. |
| Official MODUS returned calculated statistics alongside an assessment rejecting future rows. | Assess and reject before arithmetic, without switching providers. | `player-stats-observability.test.ts`: future MODUS history rejects; DartsOrakel is not called. |
| Rejected history was excluded from averages but still counted in head-to-head results. | Supply only accepted histories to H2H in both manual and fixture analysis; retain valid reverse-perspective evidence. | `matchup-analysis.test.ts`: both entry points exclude rejected rows and retain a valid meeting from the other player. |
| Distinct canonical IDs with normalized-equal names collapsed into one v1 job. | Reject ambiguous associations before manifest creation or history acquisition. Preserve v1 compatibility. | `research-fixture-collection.test.ts`: rejection, zero scrapes, no manifest. |
| Same-player odds slots cleared old numeric fields but retained research/coverage/quality through object spread, so briefs still appeared after rejection. | Construct the unresolved result explicitly, retaining no derived research payload. | `value-research.test.ts`: no research/coverage/assessment and no rendered brief/disjoint statistics. |
| Budget close disconnected forwarding listeners before closing the underlying budget, leaving exposed signals usable. | Native composition preserves close propagation and removes the forwarding lifecycle. | `research-collection-plan.test.ts`: both signals abort and timers clear. |

Seven faults were demonstrated with failing regression assertions before their
fixes. Budget close was identified by control-flow inspection and has a passing
direct regression test. These tests establish the counterexamples and tested
invariants, not correctness for every possible execution.

**Presentation clarification:** generic "chronological trend unavailable" could
appear next to a valid five-vs-five trend because the assessment described
ten-vs-ten. It now says "Disjoint 10-vs-10 trend unavailable". PDC/MODUS diagnostics
immediately follow their player's statistics. Both formatter tests assert wording
and placement; pagination tests still pass.

## Decisions deliberately not taken

- **No disk-cache redesign:** warm-first planning inspects process memory. A fresh
  CLI process starts cold for planning, although the reader can subsequently reuse
  fresh disk evidence. Disk-warm work can still wait behind earlier cold work.
  This is a scheduling limitation, not global warm-first collection.
- **No repeated disk preflight scan:** `FileEvidenceLedger.latest` scans retained
  records. Calling it for every participant adds up to participants-times-records
  reads before ordinary acquisition repeats lookup. This can consume the same
  deadline the planner should protect. A bounded single-pass index warrants its
  own measured acceptance test, not an unmeasured review-time expansion.
- **No blanket serial production strategy:** the existing synthetic counterexample
  completes 16 of 32 cold participants serially versus 22 with four-way collection.
  Retain current PDC concurrency; do not portray that simulation as live latency.
- **No prediction-policy rewrite:** existing matchup thresholds remain legacy
  descriptive heuristics, not calibrated probabilities. Their decision accuracy
  was not established by this review.
- **No new dependency, storage version, schedule, deployment or send:** strengthen
  existing boundaries rather than introduce another workflow engine.

## Verification

- `npm run verify:research`: passed TypeScript, **754 tests across 81 files**,
  reuse benchmark and all nine planning scenarios.
- Ten test cases added relative to the 744-test package checkpoint; existing
  value and formatter assertions were also strengthened, not relaxed.
- `npm run audit:prod`: **0 reported production vulnerabilities**. This accesses
  the package registry; it is not a security certification.
- `git diff --check`: passed. LF/CRLF notices are not whitespace failures.
- No dependency-lockfile or production-cron changes. No live scraping,
  Telegram send, deployment, commit or push.
- Ignored local verification log: `.tmp/research-review-verification-final.log`.
  The reproducible tests/commands, not that temporary log, are the durable evidence.

## Review limits

Review covered collection/inventory, evidence/quality, statistics integration,
formatters, CLI, CI and verification. Two existing Luna agents received independent
read-only standards/spec assignments; both hit their usage limit before final
reports. One reported the disk-warm limitation. The main agent completed fixes and
final review; no completed independent sign-off is claimed. No new agents or
concurrent write scopes were introduced.

No repository issue-tracker integration document was present; the package plan
served as the spec. If issue-tracker review automation is desired later, configure
it through `/setup-matt-pocock-skills`; no unrelated tooling was added here.

Real provider coverage/latency, source freshness, unknown formats, hosted durability
and prediction calibration remain unverified. The offline fetch guard is not an
OS network firewall. These limits remain explicit despite passing tests.

**Review totals:** standards: two simplifications addressed; spec: eight correctness
findings fixed plus one presentation clarification. Highest-impact standards
finding: duplicated cancellation lifecycle. Highest-impact spec finding:
identity/evidence rejection did not stop every derived output.
