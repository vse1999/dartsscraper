# Watchlist v2 implementation progress

Date: 2026-09-28. Execution reference: `ODDS_WATCHLIST_FREE_FIRST_PLAN.md`.

## Delivered locally

- Repaired the interrupted quota-policy refactor and restored a passing TypeScript build.
- Migrated screening to optional source-update timestamps, optional context and optional 180/leg data. Required last-ten average/weighted-checkout evidence remains mandatory; last-twenty evidence is optional and checks direction when sufficiently complete.
- Added validated odds-sensitive bands and a clearly provisional starter configuration. The actual owner examples are represented honestly; the current starter settings reject both due to their checkout thresholds. These settings are not calibrated or approved for live alerts.
- Made round labels optional without changing occurrence-level deduplication identity; added generic digests and explicit v2 snapshot validation.
- Preserved actual completion/evidence checks while allowing statistics to be fetched after the odds observation. Ambiguous historical last-ten date boundaries remain blocked regardless of age.
- Added a pure free-quota policy: complete-tick costs, used/reserved allowance, overlapping-window rejection, 5/10/15-minute cadence proposals and fail-closed unverified zero-spend entitlement. Proposals require a future durable atomic reservation; no usage is reserved by this function.
- Added escaped, paginated research-preview formatting with observation time, named bookmaker, start/context, metric denominators, coverage and missing-data warnings. Incomplete last-twenty evidence is not presented as an independent full window.
- Integrated previews and advisory quota decisions into the existing local replay. Invalid or identity-changing revalidation removes an older preview. Outputs explicitly state `deliveryAuthorized: false`.
- Added a captured-response DartsOrakel history normalizer. It reuses existing statistical parsing, preserves numeric player/event identifiers and denominators, labels composite match identities, checks captured-response completeness and date boundaries, and never joins metrics by row position or invents midnight completion timestamps.

Watchlist application and test coding used Luna 5.6 XHIGH subagents, with no more than two running concurrently. Main-agent review directed correctness repairs and independently ran build, regression and replay checks. Existing PDC working-tree changes were preserved. No dependencies, routes, account actions or deployment were introduced. The owner subsequently requested committing and pushing all pending work, including the existing PDC fix.

## Run the local example

From the repository root:

```powershell
node --import tsx scripts/watchlist-replay.ts --input tests/fixtures/watchlist-v2-replay.json
```

This reads a synthetic bounded scenario and prints JSON containing one research-only HTML preview and a paused quota decision (`ZERO_SPEND_UNVERIFIED`). It uses the scenario's clock, not current live odds. It makes no network requests and sends nothing.

## Verification

- Main-agent TypeScript build passed.
- Final main-agent full regression run passed **459 tests across 52 files**, including the final formatting cleanup and additional incomplete-last-twenty formatter regression.
- Main-agent CLI smoke passed: `ok=true`, one preview, `deliveryAuthorized=false`, snapshot version 2, unverified-zero-spend quota pause.
- Windows sandbox restrictions prevented Vitest/esbuild child-process startup; approved escalated local verification passed. These errors were environmental, not reported as successful tests.
- Scoped watchlist whitespace checks passed. A targeted credential-pattern scan found no matches; this is not a comprehensive security certification.
- A Luna agent hit its usage limit during closeout, after its final test and formatting edits had been saved. Main-agent build, full tests and whitespace checks independently verified the resulting files; no substitute model performed coding.

## Important remaining implementation, not just configuration

| Plan area | Current status |
| --- | --- |
| T0 source/runtime feasibility | No verified live PDC odds contract or measured zero-charge cloud setup. Earlier rendered-table evidence does not establish all required identity/status/start fields. |
| T1 core | Implemented and locally tested. Starter thresholds remain provisional. |
| T2A adapters | Captured OddsPortal table parsing and DartsOrakel history normalization exist. Live odds transport, complete quote mapping, provider-client wiring and shared history cache/invalidation are not implemented. |
| T2B persistence | No durable watchlist database, migrations, atomic claims, fenced leases or delivery outbox adapter has been implemented. Replay JSON is not a production replacement. |
| T3A runtime | Quota policy and local replay exist; no authenticated cloud collector/scheduler or durable runner integration. |
| T3B Telegram | Pure preview formatting exists. Owner commands, live sender integration and durable outcome handling remain. |
| T4-T6 validation/rollout | Local tests/replay passed; no real-source load measurement, shadow session or alert rollout occurred. |

The history adapter intentionally requires complete captured required-statistic responses. A truncated API page is not proof of the newest twenty matches. It also suppresses date-only results close to observation (48-hour guard) and ambiguous last-ten cutoffs; an ambiguous last-twenty boundary can fall back to a proven last-ten window. This restricts same-day tournament research until source completion/timezone/ordering evidence supports a less restrictive policy. It never silently discards recent rows to substitute older statistics.

## Next evidence and rollout gates

1. Verify one permitted odds source with actual PDC event samples and reliable player mapping, named bookmaker, open/prematch status and start time. No bookmaker login, betting interaction or access-control bypass.
2. Establish a history acquisition contract that proves query scope/completeness and same-day ordering/completion where needed. Pure schema validation cannot authenticate provider claims.
3. Select and measure one zero-charge cloud runtime and durable storage target; include cold histories, retries, rechecks, storage and logs. No paid fallback is authorized.
4. Implement the remaining persistence, runner and owner workflow against those verified contracts; then seek the separate production migration/deployment/collection approvals in the approved plan.
5. Review starter settings and run a shadow pilot before approving private notifications. Measure usefulness and time saved, not betting profitability.

No automatic alerts are active. Passing tests establishes local behavior only, not data rights, real-world coverage, measured hosting capacity or betting edge.
