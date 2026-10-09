# PDC player lookup regression — 9 October 2026

**Follow-up:** the average-first approach below was insufficient for the user's required 180/checkout coverage. Production PDC commands now use sequential complete-statistics batches; the read-only real-source test retrieved all three ten-row statistic views for all 32 players. See `PDC_COMPLETE_STATISTICS.md`. The investigation below remains historical evidence for the identity/deadline causes.

## What failed

This was primarily a collection/deadline regression, not DartsOrakel losing its top players. A cold reproduction for the 16 Swiss fixtures returned histories for **18/32 players** at the unchanged 220-second research deadline. Dave Chisnall, Alan Soutar and Raymond van Barneveld timed out; Damon Heta, Michael Smith and other later-listed players were never started. Earlier owner-chat testing returned 19/32; network timing changes the exact cutoff.

Three concrete causes were reproduced:

1. **Encoded names:** the live public directory contained 6,388 rows, including 25 names containing HTML/entities. William's row was `William O&#039;Connor`, player ID 30, not the plain spelling the user/provider supplied. Opponent parsing already decoded entities, but directory parsing did not. Both fixture and history resolvers inherited that mismatch.
2. **Request starvation:** each fully enriched player history normally needs average, 180 and checkout views. The shared reader starts requests at least 3,200 ms apart. Even the ideal 32-player/96-view workload takes approximately 304 seconds between first and last request starts, before directories, lookback expansion, latency or retries. It cannot fit the 220-second research budget. Completing early players' optional metrics first starved the rest. [Jina's published Reader limit](https://jina.ai/reader/) is 20 requests/minute without a key; increasing concurrency does not remove this limit.
3. **Cross-provider display names:** Eredmenyek's verified `Fehlmann A.` row links a profile slug naming Alexander; DartsOrakel's directory names player 15005 Alex Fehlmann. Expanding the slug and then discarding the original abbreviation prevented the existing strict resolver from finding the unique directory entry. No hardcoded nickname assumption is needed.

Additionally, a failed optional 180/checkout HTTP request previously rejected the whole history even after valid average rows were fetched.

Primary public evidence: [William's DartsOrakel profile](https://dartsorakel.com/player/details/30/william-oconnor), [Alex's DartsOrakel profile](https://dartsorakel.com/player/details/15005/alex-fehlmann), [the provider's dated Heta–Fehlmann detail](https://m.eredmenyek.com/merkozes/M9S7q12k/), and [the public directory](https://dartsorakel.com/api/stats/player). Local diagnostics retain public capture summaries under ignored `.tmp/player-lookup/`; no credentials or private chat captures are committed.

## Small corrective changes

- Decode directory HTML entities once at the validated provider boundary, using existing Cheerio. Plain names avoid DOM parsing. Numeric/hex/named entities and whitespace normalize consistently; script/style content is not treated as a player name. Conflicting identities still remain ambiguous.
- If a verified provider full-name label is absent, retry its **actual displayed abbreviation** through the existing unique surname/initial resolver. Ambiguous abbreviations remain unresolved. No relaxed fuzzy thresholds, surname-only guessing or nickname dictionary. Fixture cache v8 removes earlier unresolved cached labels.
- PDC's optional lightweight first pass obtains every player's last-10 average/history before optional enrichment begins. It uses the same paced client and canonical resolver. Its ephemeral evidence/cache is separate from full research: average-only snapshots cannot replace full snapshots or durable evidence. Full research still acquires 20 for last-20 context; the lightweight pass needs only 10.
- Already-fresh full evidence is reused during the first pass. Otherwise enrichment remains the existing full reader, deliberately revalidating its own canonical acquisition rather than mixing snapshots from different source observations. This can repeat an average read; correctness and explicit provenance take precedence over an unverified cross-snapshot join.
- A deadline or failed enrichment preserves the successful base history in the final report and partial callbacks. Unread/absent histories remain explicitly unavailable; optional fields are not invented or set to zero. A base identity failure is not repeatedly retried in the same slate.
- For personal/full scraping too, an optional statistic's transport failure retains valid averages and any other successful optional view. Malformed schema/correlation data and caller cancellation still fail closed. Missing metric coverage remains visible.

## Verification

- Live before/after cold read-only run, same date and 220-second limit: **18/32 → 31/32** histories, all available players returning 10 rows. This intermediate run preceded the displayed-abbreviation correction; its remaining miss was Alexander/Alex Fehlmann.
- Intermediate configured owner-chat `/pdc today` smoke delivered **16/16 images**, zero error logs, with **31/32** histories retained. It proves delivery and deadline preservation, not complete optional metrics or the final alias correction.
- Final production-path read-only diagnostic: `npx tsx scripts/pdc-player-coverage-smoke.ts 2026-10-09` returned **all 32/32 histories**, each with **10 rows and 10 averages**, including William O'Connor and Alex Fehlmann. Runtime 220,012 ms under the same 220-second research deadline. Eight players also completed all ten 180/checkout rows; the other players' optional fields remained explicitly unavailable. This validates history coverage, not universal full-metric coverage.
- Regression checks cover encoded identities, ambiguity, provider abbreviation fallback, 32-player phase ordering, cancellation during both phases, preserved partials, genuine identity failures, optional transport failures vs invalid source structure, isolated ten-row acquisition and warm full-evidence reuse.
- Full suite: **825 tests / 88 files passed**. TypeScript build passed; production dependency audit found zero vulnerabilities.

## Remaining boundary

Under the unchanged unauthenticated Reader rate limit and serverless deadline, a large cold slate still cannot guarantee full 180/checkout enrichment for every player. The improvement guarantees that successfully fetched valid histories are not thrown away while waiting for those optional metrics. No higher rate, paid key, new dependency, browser, new durable store or billing setting was enabled. Source outages or genuinely absent/ambiguous players can still yield explicitly unavailable histories. Hosted behavior requires deployment verification after push.
