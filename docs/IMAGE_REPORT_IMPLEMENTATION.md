# Image report implementation — 9 October 2026

## Final correction: one ten-match image and official PDC discovery

Personal ten-match reports now produce **one** image, not two five-row pages. The compact summary appears once; date, opponent/round, result/score, average, 180s and checkout are aligned in a single ten-row table. Repeated tournament names are mapped to shared event labels, with the complete names in a legend. Twenty-match requests use two ten-row images. Missing metrics and consequential warnings remain visible; full page context and provenance remain in text fallback.

Final live owner-chat smoke: **one image delivered and one expected** for `Rob Cross last 10 matches`, webhook200 and status edit successful. The smoke now asserts the exact expected image count.

Official PDC discovery is API-first with dated PDPA fallback and cache v6. Read-only live checks found 70 official pairings on 8 October and detected the Swiss event on 9 October without published/verified named pairings. The Telegram command now distinguishes that publisher coverage gap from a no-match day. See `PDC_DISCOVERY_FIX.md`.

Final combined checks: **798 tests passed across 85 files**, TypeScript build passed, production audit zero vulnerabilities. The earlier cache-test failure was eliminated by using a writable workspace `TEMP`/`TMP` for the test process; no cache code or assertions were changed. This was a test-environment constraint, not an image-renderer regression.

The sections below record the earlier implementation/verification before this correction; their five-row paging and two-photo smoke results are superseded by this section.

## Delivered scope

- Configured bot personal player requests, multi-player batches and player-detail callbacks use deterministic image pages.
- Scheduled MODUS and PDC matchups use paired image cards. PDC supporting match rows are available through the player keyboard rather than automatically duplicating all histories.
- Completed PDC results, roster-only MODUS fallback, `/compare`, `/odds` and `/value` retain their existing text flows.
- `REPORT_IMAGES_ENABLED=false` restores the original text paths; configured production factories default to images. The current remote deployment has not been changed.

## Why the simpler native renderer

`@resvg/resvg-js@2.6.2` rasterizes bounded, escaped SVG directly. A fixed statistics layout needs text and shapes, not JavaScript execution or browser networking. This removes the browser executable, startup/cleanup and external rendering service from image generation. The existing Chromium dependency remains exclusively for the existing odds collector.

The font is bundled Noto Sans under SIL OFL, with `public/fonts/OFL.txt`. No installed Windows/system font or remote font fetch is required. Upstream font: https://github.com/google/fonts/tree/main/ofl/notosans. Native renderer source/API: https://github.com/thx/resvg-js.

The latest 100-render local benchmark measured approximately **97 ms of process CPU per card**, **189 ms median wall time**, and an **87.5 kB** matchup image. Earlier local runs varied with machine/runtime load (roughly 74–90 ms CPU/card). Native worker-thread CPU is part of the measured Node process, unlike the earlier browser benchmark, which excluded browser subprocess CPU. These are local measurements, not Vercel telemetry, and the layouts/pixel dimensions differ from the earlier browser prototype.

At the latest local CPU measurement, 500 requests × the 25-image cap would spend about **20 minutes on rendering**, excluding research, sending, retries and other account activity. This supports the choice but is not an account-wide free-tier guarantee. There is no extra scrape per image, AI API, paid image service, durable image cache or Blob dependency.

## Delivery and safety

- Five match rows per personal page; all retrieved rows are retained, including event/round context. Text fallback pages preserve their statistics, warnings and proof links.
- At most 25 image cards per full report. Remaining fixtures are batched into text pages instead of omitted.
- Images have bounded input/layout, 900-pixel width, maximum 2400-pixel layout height and 1 MB PNG budget. Oversized/failed renders become text, not smaller illegible fonts.
- Unavailable fields remain unavailable. Coverage counts, weighted checkout denominators, stale/partial/identity/order warnings and descriptive-statistics limitations stay visible.
- Photos use the existing shared per-chat delivery policy: paced sends and bounded explicit429 retries. Paid broadcasting is explicitly false.
- Photo render failures and definitive Telegram HTTP400 rejections use paginated text. Ambiguous network/5xx outcomes are not retried or followed by potentially duplicate fallback messages. Authorization and cron protections are unchanged.
- Report total deadlines and personal delivery timeout still apply. No sends are started once the relevant signal is aborted.
- A live multi-page test exposed native AbortSignal binding reuse: subsequent pages failed when passing the same report signal directly to napi-rs. Each native render now gets its own child controller linked to the report deadline. A real three-render regression test verifies shared report-signal reuse without removing cancellation.
- Font and Linux native binding assets are included via schema-valid string globs for both endpoints. The existing Chromium assets remain included. Local test artifacts are excluded from deployment.

## Verification

- TypeScript build passed.
- Eleven renderer/transport tests and three image-route integration tests passed, covering real PNG output, multi-page cancellation, escaping, missing values, paging, cap/fallback preservation, paid-broadcast flag, render/HTTP400 fallback, explicit429 retry, cancellation, owner isolation, MODUS outcome/keyboard and PDC evidence routing.
- Existing bundle guard remains a schema-valid string check and now verifies the Chromium, font and native-renderer asset paths.
- Full suite: **781 passed; one pre-existing failure** in `tests/cache.test.ts` (cache read returns null). This same failure was reproduced before the image implementation; the cache implementation/test were not modified.
- Production dependency audit: **zero vulnerabilities**.
- Real owner-chat smoke test: webhook200, completed source lookup, status edited, **two photo messages successfully delivered** through the configured production bot path. No render fallback was needed after the signal fix.
- Matchup and personal PNGs were visually inspected locally. This does not establish all Telegram client accessibility or all possible provider-string layouts.

## Release boundary

No commit, push, deployment or billing change was performed. Hosted Linux bundle startup and provider-metered CPU/memory still need an explicitly authorized preview deployment before production release. The local smoke uses the same bot code and real Telegram delivery but runs on this computer, not the remote Vercel runtime.

The 25-image cap is per report, not a globally enforced monthly quota. Account-wide usage and workload remain relevant. No process-local counter is misrepresented as a durable cross-instance usage cap. Keep the free/noncommercial plan requirements and the budget analysis in `REPORT_IMAGE_FREE_TIER_BUDGET.md` in mind.
