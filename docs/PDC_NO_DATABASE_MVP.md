# PDC no-database MVP: product decision and pilot

**Decision:** continue with an on-demand, owner-only MVP. Do not add a database, a new queue, or scheduled PDC prefetch just to keep making progress. The current product value is a trustworthy schedule preview and independently complete matchup research—not automatic freshness or crash recovery.

This is a best-effort service. Process-local caches can make warm requests cheaper, but a cold request, another serverless instance, a restart, or a terminated invocation may repeat work or stop a report. A signed continuation proves that a job was authorized; it does not make execution or Telegram delivery durable or exactly once.

The continuation endpoint now depends on a small `PdcJobReceiptStore` contract rather than a raw `Map`. The current in-memory implementation atomically suppresses duplicates only inside one warm process. This is a replaceable adapter boundary, not a claim that a future database can be dropped in without designing durable admission, leases, and recovery.

## MVP contract

- The owner asks for `/pdc today` or `/pdc tomorrow`; there is no unsolicited PDC report or background PDC polling.
- Show validated named fixtures first. Keep pending slots and unavailable events visible; never describe an incomplete calendar as an empty day.
- Research only named participants. A pairing is a complete card only when both players have usable history; isolate a failed pairing rather than presenting a partial card as complete.
- Missing source metrics stay unavailable. An ambiguous Telegram outcome is not blindly retried.
- If a function stops mid-report, the owner may need to request the report again. Do not promise automatic recovery, global provider throttling, or a fixed full-report completion time.

These guardrails are already represented in the current PDC command/job path and architecture doc. This file records how to evaluate it as a product while shared persistence is unavailable.

## Safe pilot and evidence

No deploy, Telegram message, or production change is performed by this plan. After an authorized owner-side deployment, use ordinary on-demand requests as the pilot; do not create a cron job or send a broadcast.

For the first ten owner-initiated reports, record the log sample count and review:

| Product question | Existing signal | What it tells us |
|---|---|---|
| Did the user get useful schedule information quickly? | `PDC schedule preview delivered.` with `phase=first-useful-output`, `durationMs`, `calendarStatus`, `namedFixtures`, `pendingSlots`, and `previewParts` | Time to the first useful output and whether discovery gaps were explicit. |
| Did research produce complete value? | `PDC isolated statistics batch processed.` with `processedPairings`, `readyPairings`, `failedPairings`, `playerLookups`, `metricGapPlayers`, and `durationMs` | Completed versus withheld pairings, and whether source metric gaps are limiting usefulness. |
| Did the report finish as promised? | `PDC report completed.` or `PDC full statistics job stopped.` with stage/cursor and outcome counts | Completion and the boundary at which a best-effort job stopped. |
| Is Telegram delivery becoming a bottleneck? | `telegram_http_response` with operation/status/outcome/duration, plus `telegram_delivery_unknown` | Rate limits and requests whose acceptance could not be confirmed; these logs intentionally omit message text, chat ID, and bot token. |

Ten reports are a discovery sample, not a reliable p95 claim. Keep the denominator, distinguish quiet from busy event days, and do not average away partial schedules or failed pairings. A successful fixtures-only smoke is evidence of schedule parsing only; it is not evidence of history quality, Telegram delivery, or production latency.

## Decision gates after the pilot

1. **Keep the no-DB MVP** if users get a useful preview, fixture identity remains correct, and failures are understandable. Continue on-demand operation; fix only observed friction.
2. **Improve the existing read path first** if latency comes from avoidable source calls or poor cache behavior. Measure request reuse and correct source coverage before tuning concurrency.
3. **Revisit a shared store** only when evidence shows a product problem local caches cannot solve: repeated cross-instance cold reads are costly, users see unacceptable freshness/latency, or duplicate/unfinished work repeatedly harms delivery. Pick one store that can support both snapshots and atomic work admission; document ownership, cost, retention, and outage behavior before implementation.
4. **Revisit prefetch last.** It is justified only after shared validated snapshots and durable admission/recovery exist, the observed freshness need is real, provider capacity is verified, and prefetch can be disabled without breaking on-demand reports.

## Rollback and stop conditions

Stop the pilot and disable the affected report path on wrong fixture/player association, wrong requested date, fabricated metrics, duplicate known-sent cards, unauthorized Telegram delivery, or unbounded provider traffic. A pending/unpublished opponent is an expected coverage state, not by itself a rollback trigger. Keep local smoke tests read-only and never use a production Telegram send as a test without explicit authorization.

See [the PDC architecture](./PDC_UPCOMING_ARCHITECTURE.md) for current runtime boundaries and tests. The log stream is diagnostic evidence only; it is not a durable job ledger, cache, quota coordinator, or recovery mechanism.
