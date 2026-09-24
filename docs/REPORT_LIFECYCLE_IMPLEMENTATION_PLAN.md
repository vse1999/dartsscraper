# Bounded report lifecycle implementation plan

Status: implemented and locally verified on 2026-09-24; not committed or deployed.

## Objective and acceptance criteria

Concentrate lifecycle ownership for `/compare` and `/pdc` without changing research results, formatting, source selection, or execution modes. This is a reliability refactor, not a workflow framework or a profitability improvement.

- Preserve compare research/total budgets of 120/150 seconds and PDC budgets of 220/280 seconds, including injectable test clocks and durations.
- Await acknowledgement before research or scheduling. Failed/uncertain acknowledgement means no research.
- Register background work before allowing its research callback to execute. Registration failure must not fall back to foreground execution.
- On registration failure, make at most one acknowledgement edit, only if acknowledgement delivery was confirmed, time remains, and no delivery is uncertain. If editing is unsupported, log the failure without sending a replacement message.
- Check elapsed time and cancellation before invoking each research/delivery operation; pass cancellation into the operation and race non-cooperative promises.
- Observe late rejections, clear timers/listeners, and stop all new deliveries after an uncertain delivery failure. Cancellation cannot retract externally accepted messages.
- Preserve successful compare histories and PDC partial snapshots when research expires. Do not change `/pdc latest` to background execution.
- Keep command-specific outcome strings, research counts, and delivery accounting; add safe shared lifecycle events for acknowledgement, scheduling failure, execution failure, and completion.
- Neither command should directly create/close the report budget or orchestrate promise races after migration. This deletion test is required: merely relocating the old choreography is insufficient.

## Scope and hard guardrails

- No changes to MODUS workflows, source adapters, cache policies, statistics, report text/formatters, pagination, authorization, or transport pacing/retry rules.
- The only new user-visible text is the approved bounded scheduling-failure acknowledgement edit.
- Reuse `src/daily/report-budget.ts` unchanged. Do not add dependencies, infrastructure, persistent jobs, or recovery guarantees.
- No TypeScript `any`, unsafe assertion shortcuts, raw exception text in logs, secrets, live source requests, or real Telegram sends.
- Preserve unrelated working-tree edits. Never restore/delete another agent's files.
- No commit, push, deployment, or configuration changes in this task.
- Maximum two active coding subagents, both Luna 5.6 with XHIGH reasoning. No further delegation by them.

## Shared module contract (freeze before integrations)

New `src/daily/report-lifecycle.ts`, owned by Agent A:

- `ReportSession.research<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>` owns research admission and racing.
- `ReportSession.deliver<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>` owns delivery admission, cancellation, racing, and latching uncertain delivery failure.
- `ReportSession.canResearch(): boolean` and `canDeliver(): boolean` expose eligibility for command-specific skipped accounting, not raw budget ownership.
- `runReportLifecycle<TAck, TResult>` takes budget options, logger, safe context, an acknowledgement callback, a report callback receiving session plus acknowledgement, optional background scheduler, and optional scheduling-failure edit callback.
- Return a discriminated lifecycle result: `completed` with report result; `started`; or `failed` with phase (`acknowledgement`, `scheduling`, `execution`). Commands map this into their existing public outcome strings.
- Scheduler takes `Promise<void>`, matching the existing scheduler contract. Use a deferred acceptance gate so rejected registration never invokes report research. Observe both gate and task promises.
- Do not expose close, raw controllers, or raw budget to consumers. The module closes resources on every terminal path; a successfully scheduled report retains resources until its task finishes.
- Report callbacks are trusted composition: every external asynchronous operation must use `session.research` or `session.deliver`. Bound those operations, not the outer composition with a competing deadline race; the latter can discard partial-delivery accounting while nested failures unwind. Arbitrary non-session waits inside report callbacks are unsupported.
- Keep delivery page counts command-specific. Shared delivery refusal must not overwrite prior uncertainty or cause a fallback send.

Agent A must publish exact exported names/types to Agent B before B integrates. Any necessary contract adjustment must be communicated to the orchestrator and both agents; no silent incompatible changes.

## Step-by-step tasks and ownership

### 1. Baseline — orchestrator

1. Inspect status, relevant instructions, commands, deadline helper, and existing tests.
2. Run existing tests/build. Record baseline failures separately.
3. Save this plan; give agents disjoint file ownership and acceptance criteria.

### 2. Shared lifecycle and compare — Agent A

Own only `src/daily/report-lifecycle.ts`, `src/telegram/compare-command.ts`, `tests/report-lifecycle.test.ts`, and `tests/compare-lifecycle.test.ts`.

1. Implement the agreed lifecycle module around the existing budget helper.
2. Cover acknowledgement gating, scheduling rejection before research, safe failure edit, late rejection, total/research admission, cleanup, and uncertainty latching at the module interface.
3. Migrate compare without changing analysis, report formatting, or return semantics. Preserve per-player metrics and delivery accounting.
4. Remove compare's direct budget creation, racing, cleanup, and scheduler choreography.
5. Retain all existing compare tests; extend scheduling-failure and stopped-delivery tests.

### 3. PDC characterization and migration — Agent B

Own only `src/telegram/pdc-command.ts`, PDC responder wiring in `src/telegram/bot.ts`, and new `tests/pdc-lifecycle.test.ts`.

1. Before module availability, inspect PDC tests and prepare command-level characterization with mocked dependencies; do not invent a competing lifecycle abstraction.
2. After Agent A publishes the contract, migrate acknowledgement, research racing, scheduling, cleanup, and sends to the shared module.
3. Preserve PDC partial snapshot delivery on research timeout and foreground `/pdc latest` behavior.
4. Add optional acknowledgement edit capability without breaking existing reply-only test adapters; the production adapter returns the acknowledgement message ID and passes cancellation to its edit operation.
5. Registration failure must perform no lookup; use only the confirmed acknowledgement for a bounded edit. Never send an extra failure reply after uncertain delivery.
6. Test failed acknowledgement, thrown scheduler, edit unavailable/failed/timed out, expired total budget, uncertain report page, partial snapshots, and foreground latest mode.

### 4. Integration and independent verification — orchestrator

1. Inspect the final diff against the plan and validate the shared-module deletion test.
2. Check command outcome compatibility and signal propagation through the production PDC adapter.
3. Run focused lifecycle/compare/PDC/deadline/Telegram tests, then full `npm test` and `npm run build`.
4. Inspect diff whitespace and scope; ensure MODUS, formatting, and source implementations are unchanged.
5. Return bounded corrections to the owning agent, rerun checks, and record final evidence here.

## Monitoring, rollback, and completion gates

- Use existing structured logging; distinguish acknowledgement failure, scheduling rejection, uncertain delivery, skipped work, and execution failure. Do not log request text, names, tokens, or raw upstream error payloads in new lifecycle events.
- Acceptance is measured by passing adversarial tests, preserved outputs/execution modes, and removal of duplicated lifecycle ownership from both commands—not speculative time or incident savings.
- Tests must demonstrate no operation callback is invoked after admission fails and no research callback runs on rejected registration. Successful background work must not be canceled when its handler returns.
- Keep changes isolated so rollback restores the two command integrations and removes the new module without changing data or infrastructure. No automatic rollback or Git history rewrite is authorized.
- Live smoke testing and production rollout remain separate, user-authorized work.

## Verification record

- Baseline: 350 tests passed across 41 files; TypeScript build passed.
- Initial integration: 48 focused tests passed; an exact-optional-property error in the new test logger was identified and corrected.
- Integration review removed a competing outer deadline race, preserving command partial-delivery accounting; the new compare cutoff regression verifies this explicitly.
- The new production-adapter regression initially failed because its synthetic Telegram update lacked a command entity. The fixture was corrected without relaxing its send/edit or no-research assertions.
- Final `npm test`: 371 tests passed across 43 files (21 added tests).
- Final `npm run build`: passed. `git diff --check`: passed; only existing Windows line-ending conversion notices appeared.
- Deletion check: neither command contains `createReportBudget`, `raceWithReportDeadline`, or `budget.close` after migration.
- Scope check: only the shared lifecycle module, compare/PDC commands, PDC bot responder wiring, associated tests, and this plan changed. MODUS, the existing budget helper, formatters, statistics, source adapters, and transport policy are unchanged.
- No live source calls, real Telegram sends, commit, push, or deployment performed. Cancellation cannot retract a message already accepted by Telegram; uncertain delivery is recorded and subsequent sends stop.
