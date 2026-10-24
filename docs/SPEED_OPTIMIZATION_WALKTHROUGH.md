# Speed & Time Optimization Walkthrough

**Original execution date:** 2026-10-20
**Review note:** 2026-10-24
**Status:** Earlier code changes remain, but the speed figures below are models/simulations—not end-to-end or production measurements.

---

## 1. Executive Summary

The repository has configurable Reader pacing, optional authenticated Jina transport, process-local caches, and concurrent odds-profile parsing. Those changes can reduce modeled wait time, but this document does **not** contain a live DartsOrakel, Vercel, or Telegram end-to-end benchmark. The earlier 10.7x–12.8x and 2.0x figures were produced by synthetic/modelled workloads; they do not prove a production speedup or a Vercel compute reduction.

The 878-test result below is the historical result recorded on 2026-10-20, not a fresh verification of the current checkout.

---

## 2. Key Decisions & Changes Made

### 1. Dynamic Request Pacing & Free API Key Transport
* **Files Modified**: [`src/dartsorakel/reader-fetch.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/src/dartsorakel/reader-fetch.ts), [`src/research/config.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/src/research/config.ts), [`src/telegram/stats-service.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/src/telegram/stats-service.ts), [`api/daily-modus-report.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/api/daily-modus-report.ts).
* **Decisions & Changes**:
  * Added `resolveDartsOrakelRequestIntervalMs` to make inter-request sleep configurable (`DARTSORAKEL_REQUEST_INTERVAL_MS`).
  * Added support for `JINA_API_KEY` to pass `Authorization: Bearer <key>`. When configured, default pacing drops from **3,200ms to 300ms** (about 200 starts/minute per client).
  * Added `DARTSORAKEL_DIRECT_FETCH=true` for local non-serverless hosts (defaulting to **250ms**); the runtime now rejects this mode on Vercel/AWS serverless deployments.
  * Retained a conservative fallback: without a key, the client uses anonymous 3,200ms pacing. Explicit intervals may raise, but cannot lower, the provider-specific minimum.
* **Why Decided This Way**:
  * *Reason*: A 3,200ms throttle across 36 request starts models 112 seconds of inter-request spacing. A key enables faster pacing within the published per-key quota; actual total latency still depends on the provider, retries, and shared traffic.

---

### 2. In-Process & Persistent Cache Wiring for DartsOrakel
* **Files Modified**: [`src/cache.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/src/cache.ts), [`src/telegram/stats-service.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/src/telegram/stats-service.ts), [`api/daily-modus-report.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/api/daily-modus-report.ts).
* **Decisions & Changes**:
  * Implemented `createDefaultDartsCache`: uses `MemoryCache` on serverless and in memory test mode, and persistent `FileCache` when local retention is enabled.
  * Wired `createDefaultDartsCache` directly into `DartsOrakelClient` options inside `stats-service.ts` and `daily-modus-report.ts`.
* **Why Decided This Way**:
  * *Reason*: `DartsOrakelClient` was previously constructed without a `cache` option in `stats-service.ts` and `daily-modus-report.ts`. As a result, the 4,000-player directory (`/api/stats/player`) and historical match views had to be re-downloaded repeatedly across players. Caching them eliminates redundant network traffic.

---

### 3. Concurrent Player Profile Scraping in Odds Identity
* **Files Modified**: [`src/odds/default.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/src/odds/default.ts).
* **Decisions & Changes**:
  * Changed the inner player profile loop from sequential `for (const profileUrl of profileUrls)` to concurrent `await Promise.all(...)`.
* **Why Decided This Way**:
  * *Reason*: Each match requires verifying two player profiles. Concurrent fetches can reduce ideal wait time under the benchmark's fixed synthetic delay; they do not establish a 2.0x production speedup. Timeout and error boundaries remain in place.

---

### 4. PDC Report Transport Alignment
* **Files Modified**: [`src/pdc/default.ts`](file:///c:/Users/KomPhone/Desktop/ProjectFolder/dartsscraper/src/pdc/default.ts).
* **Decisions & Changes**:
  * Switched PDC tournament results fetching from raw `createJinaReaderFetch()` to `createResearchReaderFetch()`.
* **Why Decided This Way**:
  * *Reason*: Allows the PDC tournament scraper to share the same Jina API key and direct-fetch optimizations as player statistics, rather than being locked into anonymous public rate limits.

---

## 3. Modeled and Simulated Results (Not Empirical Production Results)

`npm run benchmark:speed` does not call DartsOrakel or Telegram. Its request table computes only ideal inter-request spacing: `(request count - 1) × configured interval`. It omits network time, retries, queue contention, cold directory resolution, image rendering/upload, and Vercel cold starts.

### 3.1 Network Launch & Request Pacing Latency

| Modeled workload | Requests included | 3,200ms interval | 300ms interval if a Jina key is configured | 250ms direct-fetch mode | Modeled ratio |
|---|:---:|:---:|:---:|:---:|:---:|
| **One warm player** (average, 180s, checkout) | 3 | 6,400 ms | 600 ms | 500 ms | 10.7x–12.8x |
| **One cold player** (directory + 3 views) | 4 | 9,600 ms | 900 ms | 750 ms | 10.7x–12.8x |
| **8-player batch** (3 views/player) | 24 | 73,600 ms | 6,900 ms | 5,750 ms | 10.7x–12.8x |
| **12-player slate** (3 views/player) | 36 | 112,000 ms | 10,500 ms | 8,750 ms | 10.7x–12.8x |
| **32-player slate** (3 views/player) | 96 | 304,000 ms | 28,500 ms | 23,750 ms | 10.7x–12.8x |

These are idle-spacing estimates, not predicted total durations. Production uses direct fetch only when explicitly enabled; direct fetch can be blocked by the source's edge protection and is not a recommended Vercel setting.

### 3.2 Odds Profile Scraping Concurrency

| Method | Simulated workload | Interpretation |
|---|:---:|:---:|
| **Sequential** | 12 × 50ms synthetic delay, plus parser/runtime overhead | Demonstrates sequential-vs-concurrent control flow only |
| **Concurrent `Promise.all`** | 6 × 50ms synthetic delay, plus parser/runtime overhead | Not a live network latency or production speedup |

---

## 4. Why the Interactive Request Became Slower

Git history identifies the latency tradeoff. Commit `89896a5` unified the interactive and bulk readers into one shared client and changed interactive pacing from **250 ms** to the **3,200 ms** bulk-safe fallback. That is sensible for anonymous Reader traffic, but makes interactive reads slower when no API key is configured. The target branch still has this fallback; the later recent-history changes do not override it.

The source calls are paced sequentially at request start, even when the 180s and checkout fetches are launched together. A cold player lookup can need the player-directory request plus average, 180s, and checkout views: three gaps × 3,200 ms = **9.6 seconds of pacing alone**. A warm directory removes one gap, but two gaps still add 6.4 seconds. Provider latency and retries come on top.

Jina's current Reader rate-limit table lists **20 requests/minute without a key** and **500 requests/minute with a key**. The no-key 3,200 ms interval allows about 18.75 request starts/minute in one client. With a key, this application uses 300 ms (about 200 starts/minute in one client), below the published per-key limit. The limiter is process-local, not distributed across Vercel instances, so shared-key traffic and 429s must still be monitored. [Jina Reader rate limits](https://jina.ai/en-US/api-dashboard/rate-limit/)

An interactive 10-row request now returns ten rows from the same 20-row enriched snapshot used by compare/bulk research. That preserves metrics and avoids a second three-view acquisition when a later command needs 20 rows; it does **not** reduce the initial cold request count. A warm instance may serve a clearly marked in-memory observation up to five minutes old while refreshing in the background (`waitUntil` on Vercel). This does not persist across cold starts or coordinate multiple instances.

Transport logs report the mode/interval and per-operation latency without exposing the Jina key or player URL. Use `dartsorakel_request_completed` and `player_research_outcome` to distinguish cache hits, source wait, and total research time. Production Vercel environment variables and live p50/p95 latency were not available during this code review.

## 5. Safe Production Configuration

For faster interactive reads without bypassing the anonymous request limit:

1. Add `JINA_API_KEY` in Vercel's encrypted environment settings. Never put the real value in `.env.example`, source, logs, or commits.
2. Remove a stale `DARTSORAKEL_REQUEST_INTERVAL_MS=3200` override if the key is configured, or set it to `300`. An override can now only **increase** the safe floor; it cannot disable request pacing with `0` or another too-low value.
3. Do not enable `DARTSORAKEL_DIRECT_FETCH` on Vercel; the runtime rejects that configuration because DartsOrakel may challenge serverless IPs. Direct fetch is accepted only on local non-serverless hosts.
4. Monitor transport mode and 429/retry outcomes after a preview release. The 300 ms limiter is process-local; if multiple instances share one key, observe aggregate quota and raise the interval if needed.

Without a Jina key the bot remains operational, but uses the conservative 3,200 ms fallback. That can still add roughly 6.4–9.6 seconds of pacing on a cold or partially warm request. The key must be supplied by an authorized operator; it is not available to this code review.

```env
JINA_API_KEY=your_key_in_deployment_secret_settings
DARTSORAKEL_REQUEST_INTERVAL_MS=300
```

## 6. Current Verification

Verification on 2026-10-24, Node `v24.11.0`, Windows:

* `npm ci` completed from the checked-in lockfile and reported zero vulnerabilities.
* `npm run build` passed (`tsc --noEmit`).
* `npm test -- --reporter=dot` passed: **92 files / 895 tests**.
* `npm audit` and `npm audit --omit=dev` each reported **zero vulnerabilities**.
* `npm run benchmark:speed` completed; it reports synthetic/modelled timings only and is not an end-to-end latency measurement.

The test suite also verifies that the complete PDC chunk path skips an unused average-only pre-read, preserving the separate progressive pass only for callers that consume partial research. These local checks do not verify production secrets, Vercel environment settings, hosted deployment protection, live provider quota, or end-to-end production latency.
