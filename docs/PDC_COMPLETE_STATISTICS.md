# Complete PDC statistics within the free deployment limits

## Correction

The average-first fix recovered player histories but did not meet the requirement for complete 180/checkout research. The missing values in the large slate were primarily **skipped enrichment after the 220-second deadline**, not absent DartsOrakel players. The user explicitly preferred complete statistics over speed and accepted batches over approximately 5–7 minutes.

## Why sequential batches

The public Reader limit is 20 requests/minute without a key; the current 3,200 ms request-start pacing is retained. Thirty-two players need at least 96 statistic-view reads. That cannot fit one 220-second research job, and even a 300-second function leaves no safe discovery/delivery margin. Increasing parallelism would not remove the rate limit. [Jina Reader limits](https://jina.ai/reader/), [Vercel Hobby's 300-second function maximum](https://vercel.com/docs/functions/configuring-functions/duration).

The bot now processes **four matchups per invocation**, fully fetching averages, 180s and checkout for their players, then sending those completed cards and dispatching the next sequential invocation. Each job retains a 220-second research / 280-second total budget inside a configured 300-second function. It never starts all batches in parallel. No new queue, database, paid API, Jina key, browser or package is introduced.

Verified fixtures are snapshotted once and passed to subsequent jobs; dates, players and source links are not rediscovered or guessed between batches. The existing identity decoding and unique abbreviation corrections remain. Full research still acquires twenty rows for context and displays the requested last ten.

## Safety and failure behavior

- `POST /api/pdc-report` requires the existing CRON secret and a SHA-256 HMAC over the full job using the existing WEBHOOK secret. Job version, timestamp, UUID, cursor, acknowledgement ID, fixture dates, duplicate IDs, field lengths and payload bytes are validated. A continuation cannot be altered without invalidating its signature. Jobs expire after an hour; no arbitrary chat ID or callback URL is accepted.
- Scheduling is gated: rejected background registration cannot start foreground research. Exact warm-process receipt replays are acknowledged without rerunning; changed payloads for the same job/cursor are rejected. Receipts are bounded and expire.
- Dispatch is one POST with a ten-second bound, no redirects and **no automatic retry after network/5xx ambiguity**, preventing a second send chain. Warm receipts are not durable cross-instance exactly-once protection. A crash can stop a report; uncertainty is visible in the edited acknowledgement. No durable queue/resume guarantee is claimed.
- Full bot research requires successful transport for all statistic views. Identity, schema and deadline failures withhold that batch's incomplete cards rather than silently substituting average-only cards. Already sent complete batches are retained. Genuine absent/unmatchable source values remain unavailable; values are never fabricated.
- Completion status is edited in one acknowledgement, rather than adding a noisy progress message for every step. Pairing source links are attached to each card's caption/text, and the final keyboard exposes player match rows. The global 25-image cap is retained across the entire job; later fixtures become complete batched text, not dropped.
- If endpoint/signing settings are missing, full PDC reporting is explicitly unavailable without disabling unrelated bot commands or silently reverting to partial PDC reports. `/pdc latest` remains the completed-results route. Outside Vercel, set `PDC_REPORT_URL` to the owned endpoint; on Vercel the production domain is automatic.

## Live evidence and checks

Read-only real-source pipeline test, **9 October 2026**:

| Metric | Result |
| --- | --- |
| Scheduled matchups / players | 16 / 32 |
| Players with ten average rows | 32/32 |
| Players with ten 180 rows | 32/32 |
| Players with ten checkout hit/attempt pairs | 32/32 |
| Completed batches / generated cards | 4 / 16 |
| Wall time | 352,735 ms (**5m 53s**) |

`npx tsx scripts/pdc-complete-statistics-smoke.ts 2026-10-09` runs this complete production-reader/job-runner path without Telegram sends. `--send-owner` explicitly enables real owner-chat uploads. Generated first/last card previews and public metric-count summaries remain ignored under `.tmp/pdc-complete/`. This local loop exercises batch budgets and full source acquisition; it is not, by itself, hosted HTTP continuation verification.

Tests cover signatures/tampering/expiry, unauthorized requests, invalid cursor/date/duplicate fixtures, bounded admission and payloads, rejected scheduling, warm replay/conflict, serial four-batch delivery, deadline/source failure without partial cards, ambiguous continuation without retries, global image cap, owner command routing, required statistic transport and Linux font/native bundling.

Local verification: **851 tests passed across 90 files**, TypeScript build passed, production dependency audit found zero vulnerabilities. Generated player column headings now wrap between words instead of orphaning a final surname letter.

### Cold calendar regression

The hosted lookup stopped during fixture discovery. A fresh-cache local reproduction identified official draw objects whose participant ID/first/last name fields were null. Previously the page parser rejected these unassigned slots, losing the verified event context needed by the provider fallback. Nullable source fields now parse explicitly, while unresolved participants remain excluded from named matchups. Invalid non-null fields still fail validation. A fresh-cache real-source lookup returned 16 dated fixtures after the correction; regression tests cover null slots, mixed named/unassigned rows and malformed non-null fields. The earlier full-statistics test used a cached verified schedule, so it did not cover this cold discovery failure.

The next hosted test delivered four complete cards, then stopped in the second batch's statistics stage. The live official participant label was `Rob Owen`, whereas the earlier provider-backed schedule and DartsOrakel directory use `Robert Owen`. Official fixture names now pass through a fixture-only directory adapter: exact identity wins; otherwise a given-name prefix of at least three letters plus the exact complete surname must select one non-conflicting directory ID. Ambiguity, short initials, unrelated surnames and malformed identities are rejected. This is an explicitly bounded cross-provider inference, not a general nickname alias table or a relaxed interactive player search. Fixture cache version 9 prevents reuse of the unresolved names. A fresh-cache lookup confirmed the canonical `Robert Owen` pairing. Failure statuses now include a fixed stage and optional HTTP status, never raw provider errors or credentials.

### Hosted verification after corrections

Production code commit `6e7016676b5a16a7811d224acfcc6c1cc776f902` passed Vercel deployment checks. An authenticated owner `/pdc today` test was sent to the configured production webhook at **17:42:02 Budapest time, 9 October 2026**; acknowledgement returned HTTP 200 in 1,577 ms. The actual Telegram app showed cards advancing through match 12/16 and 16/16, followed by the **16-matchup completion message and all player detail buttons at 17:48** (approximately six minutes; Telegram timestamps only provide minute precision). The observed final card had 10/10 average, 180 and checkout coverage for both players. The completion keyboard included the corrected canonical Robert Owen identity. This verifies hosted HTTP continuations and real owner-chat delivery, beyond the earlier local pipeline test. It is not a new claim that every source value or monthly CPU quota was independently measured in production.

Privacy-cropped native Telegram screenshots are saved locally under `.tmp/pdc-complete/proof/telegram-match-16.png` and `telegram-completed.png`; neither the private sidebar screenshots nor local credentials are committed. Vercel's UI showed no runtime entries for the fresh request, so root causes were reproduced with a fresh-cache real-source lookup and diagnosed via credential-safe stage statuses rather than inferred from absent logs.

## Free-tier estimate, not an account guarantee

For **500 cold 16-matchup full reports**, the measured source wait plus estimated Telegram/startup overhead is roughly 370–410 seconds/report. At an assumed 2 GB provisioned allocation, that is approximately **103–114 GB-hours/month** (500 × seconds × 2 / 3,600), before other workloads. Four chunk invocations plus a webhook is about 2,500 invocations. The user's supplied remaining memory allowance was over 350 GB-hours and invocation allowance near one million. Personal reports are cheaper; larger slates/retries and unrelated workloads are more expensive. CPU remains a separate hosted meter that must be measured, not inferred from wall time. No paid billing setting was enabled and no universal account-wide quota guarantee is claimed.
