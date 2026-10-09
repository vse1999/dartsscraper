# Image report free-tier policy evidence

Verified against current first-party documentation on **2026-10-08**. This is policy research, not an account usage audit or a Vercel-hosted performance test. No secrets or account billing settings were accessed.

## Vercel Hobby allowances

| Resource | Included allowance |
| --- | ---: |
| Active CPU (Fluid) | 4 CPU-hours |
| Provisioned memory (Fluid) | 360 GB-hours |
| Function invocations (Fluid) | 1,000,000 |
| Fast Data Transfer | 100 GB |
| Fast Origin Transfer | 10 GB |
| CDN requests | 1,000,000 |

The Hobby page describes included monthly resources, but says Hobby has no billing cycles; most exceeded features require waiting 30 days. Do not assume a calendar-month reset. Hobby is restricted to personal, non-commercial use. [Hobby plan](https://vercel.com/docs/plans/hobby) (page updated September 14, 2026).

Exceeding included Hobby usage can pause service; Hobby does not silently become paid overage. Pro and Enterprise can continue with on-demand charges. [Account plans](https://vercel.com/docs/plans), [Legacy function pricing](https://vercel.com/docs/functions/usage-and-pricing/legacy-pricing).

### Fluid versus legacy compute

Fluid charges CPU only during execution, excluding external I/O waits. Provisioned memory is allocated memory multiplied by the lifetime of the instance while requests are in flight, including I/O waits. Concurrent requests may share one instance. Both failed and successful incoming requests count as invocations. New projects use Fluid by default; that does not establish this existing project's setting. [Fluid pricing](https://vercel.com/docs/functions/usage-and-pricing).

Without Fluid, Hobby includes **100 GB-hours of duration and 100,000 invocations**. Duration is allocated GB multiplied by execution hours. The legacy page warns that a paused Hobby team may remain paused until support or account action resolves it. Consequently, the generic 30-day feature pause is not a promise of automatic full account recovery. [Legacy pricing](https://vercel.com/docs/functions/usage-and-pricing/legacy-pricing).

### Runtime constraints, separate from monthly allowance

- Hobby Fluid: **2 GB / 1 vCPU**, 300-second maximum duration.
- Standard Node function bundle: **250 MB uncompressed**, including bundled dependencies/assets and runtime layers. Cached older search snippets said gzip; the current page explicitly says uncompressed.
- Function incoming request or outgoing response payload limit: **4.5 MB**. That is not automatically a limit on an internal multipart upload directly to Telegram.
- A large-functions beta can allow 5 GB bundles for eligible Fluid projects. Avoid making a free-tier reliability promise dependent on beta eligibility.

[Function limits](https://vercel.com/docs/functions/limitations). A local browser screenshot success does not prove Linux/serverless browser startup, bundle compatibility, or provider-metered CPU use.

### Whole account/team and commercial eligibility

The usage dashboard defaults to all projects, with team and project filters. Verify the plan for the selected owning team and inspect total last-30-day usage, not just this bot's projection. Budget conservatively against combined usage until the actual owning scope is verified. [Manage usage](https://vercel.com/docs/pricing/manage-and-optimize-usage).

The legacy function documentation explicitly describes invocation and duration totals across the team's projects. This is primary-source support for avoiding a fresh free allowance per project. [Legacy function usage](https://vercel.com/docs/functions/usage-and-pricing/legacy-pricing).

Hobby cannot be used for commercial financial-gain deployments, including paid subscriptions, advertising, and paid creation/hosting. Ambiguous cases require Vercel support clarification. A small request count does not override eligibility. [Fair use](https://vercel.com/docs/limits/fair-use-guidelines).

### Do not confuse uploaded bytes with CDN billing

Fast Data Transfer measures CDN/end-user request and response traffic. Fast Origin Transfer measures CDN/function traffic. These documented definitions do not establish that every outbound function-to-Telegram upload is charged as either metric. If Telegram fetches a public image URL from Vercel, that is CDN delivery. A direct multipart upload avoids needing a public image endpoint; verify actual dashboard meters rather than asserting a precise egress charge from PNG size alone. [CDN usage](https://vercel.com/docs/manage-cdn-usage).

The Image Transformation/cache meters refer to Vercel's Image Optimization API. Deterministic custom PNG rasterization inside a function is function work, not automatically one Vercel Image Optimization transformation. Avoid that API for this report pipeline unless intentionally adopted. [Usage metric definitions](https://vercel.com/docs/pricing/manage-and-optimize-usage).

## Telegram image delivery

- Ordinary bot messaging is free. Avoid more than 1 message/second to one chat; groups are limited to 20/minute; ordinary bulk broadcasting is about 30/second. Optional paid broadcasting is unnecessary at 300–500 monthly deliveries if appropriately paced. File IDs can be treated as persistent. [Bots FAQ](https://core.telegram.org/bots/faq).
- `sendPhoto` supports direct multipart uploads (at most 10 MB), HTTP URLs (photo retrieval at most 5 MB), or Telegram `file_id` reuse. Width plus height must be at most 10,000; aspect ratio at most 20. File IDs belong to the same bot and cannot be transferred across bots. [Bot API: sendPhoto](https://core.telegram.org/bots/api#sendphoto), [Sending files](https://core.telegram.org/bots/api#sending-files).
- Design implication: generate each unique report once, upload once, store the returned file ID with a content/version hash, and reuse it for identical subsequent deliveries. New data or layout requires a new render/upload. No paid rendering service or separate image hosting is inherently needed. This is an architecture recommendation, not a deployed capability verified here.

## Existing scraper dependency: Jina Reader

Anonymous `r.jina.ai` Reader basic usage is free and limited to **20 requests/minute per IP**. Keys increase Reader rate limits but consume tokens based on output length; new keys receive a finite 10M-token grant, not an unlimited monthly allowance. Shared outbound IP traffic can matter; monthly totals alone do not establish compliance with burst limits. Anonymous web search `s.jina.ai` is unavailable. [Reader pricing/rate limits and FAQ](https://jina.ai/reader/).

## Unknowns required before an unconditional guarantee

1. Actual owning account/team plan and commercial-use eligibility.
2. Actual Fluid setting and current combined usage in the last 30 days.
3. Actual provider-metered full scrape + render + upload CPU and instance duration.
4. Reports per request, unique versus reused renders, recipients, retries, callbacks and baseline scheduled work.
5. Linux/serverless image renderer bundle, fonts and memory behavior.
6. Anonymous/keyed Jina transport and peak request pacing; no keys were inspected here.

Recommendation: retain free Hobby (if eligible), avoid paid broadcasts, use deterministic rendering and direct multipart upload, deduplicate/reuse Telegram files, enforce retries/timeouts and an application-level rolling quota with text fallback. These guardrails reduce risk; they do not substitute for measuring account usage or guarantee service availability under future provider policy changes.
