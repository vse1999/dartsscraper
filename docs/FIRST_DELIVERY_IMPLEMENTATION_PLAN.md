# First delivery implementation plan

Date: 2026-10-05. Scope: #1 evidence, #2 reusable acquisition, #3 comparable summaries, #6 briefs/feedback. No deployment, paid service, bookmaker interaction, automatic notifications or hosted migration.

Status: implemented and verified within the local-first boundary below. Final checks: TypeScript build, 679 tests across 73 files, production dependency audit (zero reported vulnerabilities), and synthetic reuse benchmark passed. Hosted durability, Telegram feedback buttons and automatic post-result collection remain explicit follow-up gates; see the walkthrough for operational limitations.

## Architecture decision and evidence

Keep the existing TypeScript modular monolith and existing provider adapters. Add a small research layer between history acquisition and consumers; retain deterministic formatting/calculation. Existing readers, schema validation, cancellation and Telegram delivery already solve those concerns. Replacing them introduces migration risk without measured benefit.

Flow: existing trusted provider -> validated match/history evidence -> canonical reusable history snapshot -> optional local append-only ledger -> deterministic summaries/brief -> existing report delivery. A local checkpoint runner reuses the same reader; it never sends messages.

Do not add Redis, a workflow framework or a database dependency for a local pilot. A validated filesystem adapter can demonstrate restart replay and checkpointing on one host. It cannot provide cross-Vercel durability: leave filesystem persistence opt-in, reject serverless local-persistence configuration, and document the hosted-storage gate. Until an approved shared quota backend exists, use one local collection process and explicitly do not claim cross-instance rate limiting.

Evidence: bulk history performs three source calls at 3.2s pacing; 32 cold players imply about 304s of launch span. Reusing snapshots addresses the actual request budget; increasing concurrency does not. Current /value has overlapping 10/20 windows, unknown format, and no win-probability model. Existing watchlist contracts demonstrate conservative identity/date handling but are not a deployed runner.

## Non-negotiable invariants

- Preserve owner-only authorization, trusted URLs, deadlines, source separation and ambiguous-send policy.
- No untrusted identifier becomes a filesystem path; hash keys. Validate every stored read and impose size/count bounds.
- Observation time is not source-update time. Unknown completion remains date-only; incomplete query scope and ambiguous order remain explicit.
- Never derive legs from ambiguous scores, infer injury/motivation, zero-fill unavailable metrics, or introduce probabilities/value rankings.
- Canonical identity and query cutoff/scope separate caches. Freshness checked against injected clock; future data rejected. Cancellation must not poison another active subscriber.
- Immutable observation records preserve corrections; cached replay must retain original observation time, not falsely restamp data as freshly collected.
- A local ledger failure is visible and must not become a false durability success. Optional persistence failure must not erase valid interactive research.
- Version analytical contracts. Keep strict TypeScript; no any, added runtime dependency, secret-bearing logs or unrelated refactor.

## Implementation sequence

1. **Baseline and contracts.** Run typecheck/regressions before changes. Define evidence/quality/snapshot contracts and migration-compatible optional match metadata. Preserve provider IDs, query scope, precision and URLs when actually present; explicitly unknown otherwise.
2. **Local ledger.** Implement bounded validated memory and filesystem stores, immutable content-addressed evidence, correction-preserving observations and latest snapshot lookup. Use safe atomic writes and validate hashes on read. Keep private evidence in ignored storage. Add corruption, malformed path/key, restart, timestamp and write-failure tests.
3. **Canonical history reuse.** Add a history service using existing resolver/scraper. Resolve canonical ID before snapshot lookup; request at least 20 rows for ordinary ten/twenty research, derive windows locally, distinguish larger requests. Share identical in-flight work with independent subscriber cancellation; cancel upstream when all subscribers leave. Reuse successful cancellable loads. Preserve exact acquisition metadata on warm reads.
4. **Production wiring without rollout effects.** Wire the same shared bulk history reader into current stats factories, and the local runtime where appropriate. Keep MODUS official history separate. Make optional local persistence configuration validated, disabled on serverless. Add contract/integration tests covering actual factories/consumers, not only unused helper code.
5. **Comparable summaries.** Implement disjoint latest-10/previous-10, observed date span, median/spread/outlier sensitivity, and 180/leg only with explicit known denominators. Keep weighted checkout and label mean-of-match-averages correctly. Unknown ordering/context is warned, not silently "fixed".
6. **Compact briefs.** Add deterministic evidence-backed deltas, contrary evidence and missing-data warnings to comparison/value/matchup cards. Rename public confidence to data coverage; disclose descriptive thresholds. Preserve source order, detailed evidence, message bounds, sanitization and source links. Avoid unsupported inferred context.
7. **Checkpoint/feedback pilot.** Add a bounded local research collection command with per-player validated checkpoints, restart reuse and explicit partial outcomes. No schedule or sends. Add local evidence-linked useful/not-useful/incorrect feedback and replay command; no public feedback endpoint. Enforce exclusive local runner ownership rather than simulate distributed locks. Document retention/recovery and permission gates.
8. **Verification and handoff.** Run targeted tests, full regressions, typecheck, production dependency audit and synthetic cold/warm/restart benchmarks. Review diff/security/cancellation behavior. Do not run message-sending smoke scripts. Live scraping, deployment and source permission validation are separate explicit gates.

## Bounded independent implementation work

- Evidence/schema/local ledger modules and their tests: independent write scope; publish contracts to main agent before integration.
- Statistics/brief modules and formatter tests: separate write scope; consume only agreed optional metadata, not ledger internals.
- Main agent: history reuse, factory wiring, local runner/feedback, plans and integration/verification. Main agent owns integration and final regression repair.

Parallelism is justified by independent module boundaries; no delegates may edit another scope or migrations/security configuration. All final integration is reviewed by the main agent.

## Acceptance gates

- Same canonical player queried for 10 then 20 in freshness interval requires one history acquisition; 20 then 10 also reuses. No cross-player/cutoff/provider contamination.
- Warm/restart reads retain evidence identity and original timestamps. Corrupt/expired data cannot masquerade as fresh. Corrections keep earlier evidence replayable.
- One subscriber cancelling does not cancel another; all subscribers cancelling stops work. Deadline failures preserve existing report partial-state behavior.
- Summary denominator fixtures and opposing-scoring/finishing brief examples pass. No probability language, stale confidence label or zero-filled missing field.
- Synthetic 4/16/32-player scenarios report actual acquisition counts and timings; no synthetic result described as real provider latency.
- CLI restart resumes completed work; concurrent local runs fail safely; feedback validates evidence ID and status. Existing offline watchlist stays delivery-unauthorized.
- Full checks pass or unrelated/environmental failures are explicitly documented. Runtime durability scope is accurately reported; hosted global quotas/recovery require second deployment adapter approval, not a false local claim.

## Primary references

- [Jina Reader quotas](https://jina.ai/reader/): account/IP budgets motivate reuse and coordinated acquisition; entitlement changes need approval.
- [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing): Hobby cannot provide frequent precise collection.
- [DartsOrakel aggregate stats](https://dartsorakel.com/player/stats/1993/darren-beveridge): richer fields exist at aggregate level; match-level availability remains unproven, so no speculative new scraping is implemented.
