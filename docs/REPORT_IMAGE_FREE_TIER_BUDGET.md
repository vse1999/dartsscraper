# Image report free-tier feasibility — 8 October 2026

## Verdict

Approximately 500 combined personal and full-report requests per month is a credible free-tier target. It is not yet a measured production guarantee. The current usage figures leave substantial capacity, but full reports multiply image count. Active CPU, source-rate limits and delivery deadlines matter more than the PNG size.

Keep the eligible personal/noncommercial Hobby plan and avoid paid services/broadcasts. That protects against intentional paid usage, but hitting the free quota can stop service. “No charge” and “every report continues working” are different guarantees. [Hobby limits and eligibility](https://vercel.com/docs/plans/hobby).

## Current account figures supplied by the user

These are user-supplied dashboard readings, not independently queried account telemetry. The 4-hour/360-GB-hour meters match Fluid Hobby allowances. The exact displayed usage interval and commercial eligibility are not established.

| Resource | Used / allowance | Used fraction |
| --- | --- | --- |
| Active CPU | 7m 28s / 4h | 3.11% |
| Provisioned memory | 3.4 / 360 GB-hours | 0.94% |
| Function invocations | 326 / 1,000,000 | 0.0326% |
| Function storage | 1.39 / 10 GB | 13.9% |
| Deployment storage | 51.69 MB / 10 GB | About 0.52% |
| CDN requests | 498 / 1,000,000 | 0.0498% |
| Fast Origin Transfer | 430.98 kB / 10 GB | Negligible |
| Fast Data Transfer | 763.38 kB / 100 GB | Negligible |

Remaining CPU at this snapshot: **13,952 seconds = 3h 52m 32s**. Remaining memory: **356.6 GB-hours**. For 500 additional requests, CPU exhaustion would occur at **27.904 active CPU seconds/request**, if nothing else consumed CPU in the same quota window. This is a mathematical ceiling, not a safe operating target.

The existing 448 CPU seconds divided by 326 function invocations is 1.37 seconds/invocation, but these invocations mix cheap webhooks, reads, callbacks and expensive jobs. It is not an observed cost per full report. Do not extrapolate the current snapshot as a full-month baseline without knowing its interval and workload mix. Daily scheduled reports, retries, additional user actions and other projects must also be budgeted.

[Fluid resource definitions](https://vercel.com/docs/functions/usage-and-pricing), [Hobby allowances](https://vercel.com/docs/plans/hobby). See the companion sources note for team scope and legacy differences.

## Measured local renderer

`scripts/report-image-benchmark.ts` performed five cold browser cycles and 25 images using a reused browser; no new scraper requests, Telegram sends or deployments were made.

- Actual PNG: **118,976 bytes**, about 119 kB; 1280-pixel-wide raster output from a 640 CSS-pixel card.
- Reused-browser rendering: **198.23 ms median, 203.46 ms p95**, 225.12 ms maximum.
- Cold complete cycle: **5311.49 ms median**. Phase medians: launch 163.49 ms, render 220.40 ms, close 4935.60 ms. Most cold elapsed time was Windows browser cleanup, not rendering.
- Node-only CPU was instrumented but explicitly excludes Chrome subprocess CPU. It cannot establish Vercel billed CPU.
- No Linux Chromium extraction, Vercel cold starts, source discovery, upstream reads, upload latency or serverless quotas were benchmarked. Raw results: ignored `.tmp/report-layout-lab/image-benchmark.json`.

These measurements show that the card is small and local rendering is practical, not that hosted active CPU is 0.20 seconds. Vercel bills provisioned memory, including external waits; its 2 GB allocation is not the process's observed RSS. [Resource accounting](https://vercel.com/docs/functions/usage-and-pricing).

## Workload multiplication

Let P = personal requests, F = full requests, K = images/full request. With one image per personal request, **images = P + F × K**, with P + F approximately 500. Include cron deliveries separately unless already counted.

The following is a sensitivity model, not measured production consumption. It assumes **0.5 active CPU seconds/image plus 5 other active CPU seconds/request**, then adds the existing 448-second snapshot. The 5 seconds covers a hypothetical base job cost, not per-image browser startup; restarting a browser for every image would invalidate the model.

| Monthly workload | Images | Raw PNG upload volume | Modeled CPU incl. current snapshot | Fraction of 4h |
| --- | ---: | ---: | ---: | ---: |
| 500 personal | 500 | 59.5 MB | 53m 18s | 22.2% |
| 200 personal + 300 full, 25 images/full | 7,700 | 916.1 MB | 1h 53m 18s | 47.2% |
| 500 full, 25 images/full | 12,500 | 1.49 GB | 2h 33m 18s | 63.9% |
| 500 full, 50 images/full | 25,000 | 2.97 GB | 4h 17m 28s | 107.3% — does not fit |

Raw PNG upload volume is not asserted to be a CDN-meter charge. Direct multipart upload goes from the function to Telegram, not from a public Vercel image URL to a visitor. PNGs need not be stored in paid Blob or committed into function bundles. [CDN meter definitions](https://vercel.com/docs/manage-cdn-usage).

Universal total-job CPU sensitivity for 500 requests: 10 active seconds/job uses 1.39 CPU-hours; 20 uses 2.78; 30 uses 4.17 and exceeds the full allowance even before current/baseline usage. Initial design target: no more than **10 active CPU seconds per complete job on average**, including all its images and attributed trigger work. This requires hosted measurement and profiling; wall-clock timeout alone does not prove it.

## Memory and invocation budgets

At 2 GB provisioned memory, 500 single-instance jobs each lasting 180 seconds consume 50 GB-hours; 300 seconds each consume 83.33 GB-hours. Including the current snapshot gives 53.4 or 86.73 GB-hours, respectively, below 360. These are simple isolated-instance estimates; overlapping instances, nested MODUS HTTP triggers, retries and other workloads add usage. Concurrent requests can share an instance, so do not blindly count both shared instance lifetimes. [Fluid accounting](https://vercel.com/docs/functions/usage-and-pricing).

Image delivery inside one existing job does not create a Vercel invocation per image. A manual MODUS command may also invoke the daily report endpoint, and callbacks invoke the webhook. Even a hypothetical 1,000 additional primary/trigger calls is only 0.1% of the invocation allowance, but preserve webhook authorization and bound repeated requests.

## Existing runtime constraints

- `vercel.json`: webhook maximum 300 seconds; daily MODUS endpoint 180 seconds.
- MODUS application budget: 120 seconds research / 160 seconds total. PDC: 220 seconds research / 280 seconds total. Rendering and photo delivery must fit the remaining phase, not run after these deadlines.
- Existing Chromium Brotli assets total roughly 70 MB. The webhook already includes its bin files, but the daily endpoint has no corresponding `includeFiles` entry. Do not assume the prototype's hardcoded Windows Chrome path works in deployed Linux functions; verify the actual traced bundle.
- Hobby Fluid is 2 GB/1 vCPU with 300-second maximum and standard 250 MB uncompressed function bundle. Runtime extraction into temporary space and deployment bundle size are different quantities. [Function constraints](https://vercel.com/docs/functions/limitations).
- Existing delivery pacing applies to text. Production `sendPhoto` must join the same per-chat pacing, deadline and bounded-retry policy. Telegram recommends at most one message/second to a single chat. Twenty-five cards require roughly 24+ seconds of send-start spacing; fifty cards require roughly 49+ seconds before extra waits. Large reports can therefore hit delivery deadlines even if the monthly CPU allowance is sufficient. [Telegram FAQ](https://core.telegram.org/bots/faq).
- The current Jina transport is anonymous; basic Reader is free at 20 requests/minute/IP. Monthly counts do not protect against bursts or shared serverless-IP traffic. No extra scraping is needed merely to render already collected stats. [Reader policy](https://jina.ai/reader/).
- The image contains the core comparison stats, not every diagnostic from the long text report. Retain consequential missing-data, stale-data and incomplete-report warnings visibly, with evidence/details available separately.

## Recommended implementation boundaries

1. Generate from the existing typed research result; do not call an LLM or scrape again per card.
2. Prefer a lightweight deterministic SVG-to-PNG renderer for the simple fixed layout, subject to Linux font/output QA. Alternatively, start at most one Chromium instance per full report, render cards sequentially and close it in `finally`. Neither alternative has been measured on Vercel here. A library-based renderer is possible; Vercel documents Node image generation with `@vercel/og`. [Image generation](https://vercel.com/docs/og-image-generation).
3. Keep fonts/assets local and prohibit renderer network access. Aim for a maximum card size around 200–250 kB and bounded dimensions; never shrink important text merely to reduce bytes.
4. Directly upload the generated image. Reuse Telegram `file_id` only for an identical data/layout/observation version; do not present a stale cached report as freshly researched. Cross-instance reuse needs suitable storage; process memory alone is not a durable global cache. Do not introduce a paid store to save small image costs. [Telegram upload and file reuse](https://core.telegram.org/bots/api#sending-files).
5. Have a text fallback for rendering failure or delivery-phase exhaustion. For huge slates, use pagination or small multi-match pages rather than dropping fixtures. Benchmark readability before adopting multi-match pages.
6. Monitor whole-account usage and set a conservative operating threshold around 70% CPU. A durable, atomic rolling quota is needed for a reliable application-wide cap; process-local counters do not enforce a global cap across Vercel instances. Provider telemetry can lag, so reserve headroom. No new monitoring automation or quota service was created here.
7. Explicitly keep optional paid broadcasting off and avoid paid image APIs/Blob. Verify actual plan and personal/noncommercial eligibility before claiming the configuration is free.
8. Before switching defaults, perform an explicitly authorized Vercel deployment benchmark: repeated cold personal reports, warm 25/50-card reports, source/network failures, bounded retry and text fallback. Attribute compute in the Usage dashboard, inspect the bundle, then extrapolate the measured weighted job mix to 500 requests plus scheduled work. Local Windows tests alone are insufficient.

## Work completed

Added a reusable local benchmark and research notes only. TypeScript build and the six layout experiment tests passed. No deployment, billing changes, new paid dependencies, user-message sends or bot default changes occurred in this analysis.
