# Free-first odds watchlist: hosting and acquisition research

Checked: 2026-09-27. Research only: no deployment, account creation, purchase, source-access permission, or production readiness is implied. Prices exclude unverified taxes, currency conversion and ancillary services. No provider can be promised free forever.

## Decision summary

**Scraping odds does not inherently require buying data or paying a scraper.** First test permitted direct HTTP/JSON access with native fetch and the existing parser stack. Select hosting only after measuring an actual tournament-sized run from the proposed cloud region. A browser working locally does not prove it will work from a cloud IP, and an HTML shell does not prove a browser is necessary.

Recommended shortlist, conditional on that test:

1. **Direct HTTP works:** existing suitable cloud capacity first; otherwise Cloudflare Workers Free. Benchmark CPU, runtime compatibility and source request pacing before selecting it.
2. **Browser required, strict zero spend:** benchmark Apify Free and Google Cloud Run Jobs. Apify offers clearer quota-stop behavior; Google offers a substantial compute allowance but more billing/operations complexity. Cloudflare Browser Run Free fits only genuinely short, batched collection.
3. **Browser required, small spend approved:** compare Render Cron's measured monthly bill against Cloudflare Workers Paid + Browser Run. Render may be cheaper for short Node/container jobs; Cloudflare may have lower operational overhead if its runtime and browser adapter fit.
4. **Ordinary Node/browser needs persistent runtime:** a small Hetzner VPS is a predictable low-cost fallback; Oracle Always Free is the zero-hosting-fee alternative if capacity and reclamation risk are acceptable.

These are engineering recommendations, not measured production results or betting-profit forecasts. No paid budget has been approved.

## Options: verified facts versus engineering assessment

| Option | Verified allowance / price | Advantages for this bot | Limitations, maintenance and verdict |
| --- | --- | --- | --- |
| Existing suitable cloud host | Owner's current plan and spare capacity not verified. | Potential incremental $0; smallest operational change. | First check commercial eligibility, frequent scheduling, memory and browser support. Do not assume the current Vercel account qualifies. |
| Cloudflare Workers Free, direct HTTP | 100,000 requests/day; 10 ms CPU/invocation. Network waiting is distinct from CPU. [Pricing](https://developers.cloudflare.com/workers/platform/pricing/), [limits](https://developers.cloudflare.com/workers/platform/limits/). | Strong free-first candidate for bounded fetch/parse/evaluate work; no VM administration. | Tight CPU allowance and Worker runtime portability require measurement. Large HTML parsing or all-player aggregation in one invocation may exceed it. Medium initial adaptation, low infrastructure maintenance. |
| Cloudflare Browser Run Free | 10 browser minutes/day; 3 concurrent browser sessions. [Pricing](https://developers.cloudflare.com/browser-run/pricing/). | Managed browser, no local PC or VM. | Daily budget is often the constraint, not request count; quota exhaustion interrupts collection. Strong pilot option, not automatically a full-day solution. |
| Cloudflare Workers Paid + Browser Run | Workers minimum $5/month; Browser Run includes 10 hours/month, then $0.09/hour; session concurrency has a separate allowance/charge. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [browser pricing](https://developers.cloudflare.com/browser-run/pricing/). | Low fixed entry cost, managed runtime/browser, good conditional value. | $5 is not a guaranteed total bill. Include storage, logs and all usage; bound runs and close browsers promptly. Medium adaptation, low infrastructure maintenance. |
| Apify Free, own Actor | $5 monthly usage credit; $0.20 per CU, where one CU is 1 GB RAM-hour. Free access stops when credit runs out until next cycle. Other platform charges also consume credit. [Pricing](https://apify.com/pricing). | Purpose-built hosted scraping runtime; usable without paying for a third-party Actor. Worth a real browser benchmark. | Credit funds at most 25 GB-hours before transfer/storage/other charges. Memory allocation and startup duration matter. Adapter/platform coupling; inspect schedule entitlement before selecting. Medium setup and low infrastructure maintenance. |
| Google Cloud Run Jobs + Cloud Scheduler | Jobs: 240,000 vCPU-seconds and 450,000 GiB-seconds monthly allowance at reference pricing; minimum one billed minute per job instance. Scheduler: 3 jobs/account free, then $0.10/job/month, not per execution. [Run](https://cloud.google.com/run/pricing), [Scheduler](https://cloud.google.com/scheduler/pricing). | Containerized Node/browser preserves ordinary runtime; potentially $0 compute for this workload. | Billing account, IAM, image storage/builds, transfer and regional pricing must be included. Budget alerts are not a spending cap. Medium/high setup, low OS maintenance. [Budget documentation](https://docs.cloud.google.com/billing/docs/how-to/budgets). |
| Oracle Always Free VM | Current documentation: Ampere allowance 1,500 OCPU-hours and 9,000 GB-hours/month, equivalent to 2 OCPUs/12 GB for Always Free tenancies; also up to two eligible AMD micro VMs. Home-region capacity can be unavailable; idle instances may be reclaimed. [Official limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm). | Ample potential browser capacity at $0 compute; ordinary server scheduling. | Not the often-repeated old 4 OCPU/24 GB promise. ARM browser compatibility needs checking. OS patching, backups, restore and reclaim handling are yours. High maintenance relative to serverless; viable but not the simplest dependable default. |
| Render Cron, paid | Minimum $1/month per cron service; compute prorated by active seconds. One run at a time; overlapping scheduled runs wait. [Cron documentation](https://render.com/docs/cronjobs). | Important cheap alternative: managed Node/container scheduling without a permanent VM; a short job can be inexpensive. | $1 is a floor, not an all-in quote. Choose browser-sufficient memory and measure charged runtime. Persist state outside the job. Medium setup, low infrastructure maintenance. |
| Render Free web service | Sleeps after 15 minutes without inbound traffic; wake-up can take about a minute; local filesystem is ephemeral. [Free service details](https://render.com/docs/free). | Useful experiments or event-driven endpoints. | Poor fit for an unattended in-process poll loop. Do not use artificial keepalive requests as a way around service limits. Prefer its actual Cron product for this workflow. |
| Railway | Free starts with trial credit, then $1/month usage allowance; 0.5 GB RAM/service. Pricing comparison lists cron jobs as Free Trial only on Free. Hobby minimum $5 with included usage, overage charged. [Pricing](https://railway.com/pricing). | Familiar managed Node deployment, convenient paid fallback. | Ongoing free scheduler and browser RAM do not fit well. Do not confuse trial benefits with recurring free entitlement. Verify commercial plan eligibility before selection. |
| Hetzner VPS | Current Germany/Finland CX23 base maximum €5.49/month, excluding IPv4 and VAT after June 2026 adjustment. [Official adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/). | Predictable base bill; conventional Node/browser/cron; avoids serverless runtime porting. | Add necessary IP, backups, taxes and administration. Available capacity and actual memory use need verification. Medium setup, higher ongoing security/OS responsibility. |
| DigitalOcean VPS | Basic 1 GiB $6/month; 2 GiB $12/month. The $4 offering has only 512 MiB. [Pricing](https://www.digitalocean.com/pricing/droplets). | Straightforward conventional server alternative. | Do not recommend the cheapest size without browser-memory measurement. Generally a higher base cost than the cited Hetzner offer; same OS/backup duties. |
| Vercel | Hobby is personal/non-commercial only and cron is once/day; Pro supports minute-level cron. [Hobby](https://vercel.com/docs/plans/hobby), [cron](https://vercel.com/docs/cron-jobs/usage-and-pricing). | Existing project integration could help if an eligible paid plan already exists. | Free Hobby is not appropriate for this paid-service workflow. An external scheduler does not remove the commercial restriction. Do not pay for Pro solely for this collector before comparing cheaper options. |
| GitHub Actions | Free plan includes 2,000 private-repository runner minutes/month. Scheduled workflows can be delayed or dropped; shortest interval is 5 minutes. [Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). | Good for CI, replay and non-urgent batch research. | Weak fit for 5–10 minute alert delivery. Setup/browser time consumes allowance shared with CI. Do not publish private business code merely to obtain free public-runner usage; permitted use must also be checked. |
| Browserless Free | 1,000 units/month, one unit per 30 seconds of connection time, with a 2-minute free session limit. [Pricing](https://www.browserless.io/pricing). | Quick managed-browser feasibility test. | At least 1 unit per separate short connection; illustrative 1,920 monthly polling sessions exceed the allowance before rechecks. Not the first full-workload choice. |

## Transparent workload model, not a forecast

Assume **8 active hours/day, one poll every 5 minutes, 20 active days/month**: 96 polls/day and 1,920 polls/month. Actual tournament schedule, rechecks, retries, pages and simultaneous events remain unknown.

If one poll collects an entire useful batch:

| Browser time per complete poll | Daily browser minutes | Monthly browser hours |
| --- | ---: | ---: |
| 5 seconds | 8 | 2.67 |
| 10 seconds | 16 | 5.33 |
| 30 seconds | 48 | 16 |
| 60 seconds | 96 | 32 |

Cloudflare's 10-minute daily free limit therefore allows an average **6.25 seconds per poll**, before alert rechecks/retries. Do not mistake per-page time for complete-poll time. At 20 separate match pages x 5 seconds, monthly browser time becomes 53.33 hours instead.

For Cloud Run Jobs, 1,920 executions with the one-minute minimum, one vCPU and 1 GiB imply **115,200 vCPU-seconds and 115,200 GiB-seconds**. Those figures fit the listed compute allowances, but long runs, extra CPUs, retries and other services change the bill. This does not prove $0 total.

For Apify, 1,920 runs x 30 seconds x 1 GB equals **16 GB-hours = $3.20 compute**, before all other charges. At 2 GB it becomes $6.40, beyond the free credit. Runtime includes more than the final page-fetch wait.

## Operational ROI

Do not estimate betting profitability from differences in averages/checkouts. Measure research throughput and usefulness instead.

- User-reported baseline: approximately 10 minutes for 7–8 manually requested matchup comparisons, not a measured recurring monthly total.
- Example only: saving 5 minutes on each of 20 research days saves 100 minutes/month before maintenance. At €15/hour, that is €25/month of time value. Subtract hosting and maintenance time; do not present it as revenue.
- A €5/month cost breaks even at 20 saved minutes/month at €15/hour; €10 breaks even at 40 minutes. These are same-currency illustrative fees, not conversions of provider dollar prices.
- A free VM taking one extra maintenance hour/month can cost more in time than a managed $5 service. Conversely, unnecessary platform migration can erase months of small hosting savings.
- Track actionable alerts, alerts dismissed, missing-data coverage, collection success, stale/late alerts, duplicates, human review minutes and maintenance minutes. Compare before/after on real tournament days.

## Acquisition appendix: why DartsOrakel can feel free

Repository evidence: `src/dartsorakel/client.ts` uses direct JSON fetches, caches, a default 250 ms request interval and bounded retries. This establishes a lightweight existing path, **not an unlimited-use entitlement**. Stats change after matches and are reusable across matchups; repeated odds collection can have different frequency and rendering costs.

The prior local feasibility note records readable rendered OddsPortal bookmaker rows. Its raw-HTML shell does not rule out a permitted direct JSON/HTTP path. The Eredmenyek URL failing in a web extraction tool is not proof that the site is unavailable or impossible to collect. Neither source has a verified cloud collector for this design yet.

Acquisition order:

1. Existing native fetch + JSON or bounded HTML/Cheerio parsing, if permitted and sufficient.
2. Open-source Playwright/Puppeteer browser only if rendering is actually necessary; the library itself does not require a paid scraping subscription.
3. Hosted browser/Actor if its measured free allowance fits, or inexpensive compute after separate budget approval.
4. Paid data API only if verified darts coverage, rights and operational savings justify it. One researched API advertises darts but currently pauses issuance of new free keys; that is not an available free solution. [Darts coverage](https://odds-api.io/sports/darts), [plans](https://odds-api.io/pricing).

OddsPortal's published commercial-use/scraping conditions require a separate permitted-use assessment; buying hosting does not grant source permission. This is not a legal ruling. Do not bypass access controls or treat a read-only request as proof of permission. [Terms](https://www.oddsportal.com/terms/).

Free schedulers only trigger work; they do not supply browser compute. Self-hosted automation software similarly does not make hosting free. Adding general orchestration tools before the simple collector is proven adds maintenance without demonstrated benefit.

The owner's existing Supabase account is another execution/storage integration to assess, but its actual plan, spare capacity and Edge/Cron entitlements were **not verified in this hosting review**. Do not assume it supplies a browser runtime or declare the database integration already implemented.

## Minimum evidence before choosing a host

Run a bounded, permitted sample covering a busy opening batch and later-round new pairings. Record HTTP versus browser need, full-poll p50/p95 duration, allocated memory, CPU, bytes, source errors, bookmaker/market coverage, identity/status correctness and the cost of rechecks. Include the cold path with uncached last-10/20 stats. Test in the target cloud region without bypasses.

Choose the cheapest qualifying option, not merely the lowest advertised price. Require durable deduplication, safe retry/restart behavior, secrets isolation, bounded logs, request pacing, quota alerts and automatic suspension when configured usage limits are reached. Billing alerts alone are not a hard cap. Keep snapshots explicitly labelled by observation time, not invented bookmaker-update time. Source failure must produce a health signal, not fabricated odds or a false claim of no opportunities.

## Practical next decision

| Measured result | First option to test | Fallback |
| --- | --- | --- |
| Direct fetch works and Worker CPU fits | Cloudflare Free, or existing eligible capacity | Render short Cron job / ordinary Node host |
| Browser batch comfortably below daily free limit | Cloudflare Browser Run Free | Apify Free |
| Browser batch exceeds daily free limit, monthly credit fits | Apify Free | Cloud Run Jobs after full billing review |
| Strict zero spend, generous VM capacity needed | Oracle Always Free if available | Accept reduced frequency/coverage; do not silently upgrade |
| Small spend approved, brief jobs | Compare measured Render Cron and Cloudflare Paid total | Small VPS if runtime portability dominates |
| Persistent ordinary Node/browser environment needed | Hetzner VPS with full tax/IP/backup estimate | Oracle if reliability trade-off acceptable |
