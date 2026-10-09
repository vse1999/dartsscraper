# Official PDC fixture discovery correction

Verified locally on **9 October 2026**, Europe/Budapest. No deployment, Telegram sends, player-history fan-out, or credential changes were performed for this investigation.

## Root cause

The previous default trusted only concrete, explicitly dated pairings parsed from PDPA event pages. Its corroboration layer returned immediately when PDPA produced an empty array. An official event existing without a published draw was therefore reported as “No scheduled PDC match was found.” PDPA's Swiss event pages currently contain entry information, participant lists and session rules, not the dated matchup rows this parser needs.

- [PDPA calendar](https://pdpa.co.uk/events/calendar/)
- [Swiss Trophy main event](https://pdpa.co.uk/event/swiss-darts-trophy-2026/): 9 October start; no concrete paired schedule in the captured page.
- [Swiss Trophy Host Nation Qualifier](https://pdpa.co.uk/event/swiss-darts-trophy-qualifiers-2026-hn/): 8 October start; registration information but no concrete paired schedule.

PDC's current public website uses a first-party JSON API for tournament and fixture data. Its public JavaScript `DartsWeb` client builds the tournament and fixture URLs below, using the public main domain `pdcservices.co.uk` configured on [pdc.tv](https://www.pdc.tv/matches). The inspected site identifies its build time as 8 October 2026. No authenticated/admin API is used.

## Live evidence

| Requested local date | Official source evidence | Outcome after fix |
| --- | --- | --- |
| 2026-10-08 | [Official tournament 10853](https://tournaments.darts.web.gc.pdcservices.co.uk/v2/10853), [tournament-specific pairings](https://fixtures.darts.web.gc.pdcservices.co.uk/v2?filter=tournamentID%3Aeq%3A10853&page.size=100) | **70 named qualifier pairings**, including completed rows (`Result`). First captured row: Rene Kern vs Alex Fehlmann, Last 8. Unknown times remain unknown. |
| 2026-10-09 | [Official tournament 10823](https://tournaments.darts.web.gc.pdcservices.co.uk/v2/10823), [tournament-specific pairings](https://fixtures.darts.web.gc.pdcservices.co.uk/v2?filter=tournamentID%3Aeq%3A10823&page.size=100) | **Event verified, zero named pairings published in this API response.** Report unavailable/unpublished, never a verified no-match day. |

[PDC Europe](https://www.pdc-europe.tv/turniere/swiss-darts-trophy-2026) independently confirms the 9–11 October event. At inspection, its participant section also says the field is established after the draw. This is not proof that no games occur; it is a current public pairing-coverage gap. No names, opponent combinations or match times were invented to fill it.

An additional trap was reproduced: `filter=startDate:eq:2026-10-08` on the fixture endpoint returned zero rows despite the tournament-ID query returning 70 rows dated 8 October. Ordinary `from`/`to` and unfiltered `tournamentID` parameters can return broad, unrelated datasets. Therefore the implementation queries the officially discovered tournament IDs with `filter=tournamentID:eq:<id>` and verifies every fixture's tournament ID and date locally. The calendar is queried by official `seasonID`, fully paginated and then date-filtered locally; January also checks the previous season for tournaments crossing New Year.

## Changes and safety

- New `OfficialPdcApiFixtureSource` is the default official source, with the existing dated PDPA draw as fallback.
- Complete paginated calendar and fixtures are schema-validated. Requests construct fixed trusted endpoint URLs; response-provided navigation URLs are never fetched. Pagination is bounded and repeated rows, inconsistent totals, wrong tournament IDs, HTTP failures and malformed payloads are errors, not empty slates.
- Completed named fixtures remain included for a requested day's report. Placeholder participants are not treated as players.
- No timezone is inferred for bare API `startTime` values. Only an explicit offset-bearing ISO timestamp is retained; otherwise time is null.
- `OfficialPdcScheduleUnavailableError` distinguishes network/schema failure from a verified event without pairings. The latter includes date, missing tournament names and any available partial fixtures. Partial evidence never silently becomes a complete slate.
- Only a complete successful official calendar with no overlapping event returns verified empty. If an event exists but has no usable dated pairings, an empty PDPA fallback does not erase that distinction.
- Fixture cache key bumped from v5 to v6, preventing pre-fix empty cached entries from concealing the corrected discovery.
- Existing live corroboration remains supplementary; it cannot introduce unrelated live-feed fixtures. No trust gate is relaxed.

## Reproduction and verification

```powershell
npx vitest run tests/pdc-official-api.test.ts tests/pdc.test.ts
npm run build
npx tsx scripts/pdc-upcoming-smoke.ts 2026-10-08 --fixtures-only
npx tsx scripts/pdc-upcoming-smoke.ts 2026-10-09 --fixtures-only
```

The discovery-only smoke mode prints fixture provenance and counts, performs no player research and sends no messages. 8 October returned `verified`, 70. 9 October returned `unavailable` with the named official event and explicit unpublished/unverified pairing explanation (exit code 1, expected for this source-coverage state).

Regression captures in `tests/pdc-fixtures/` preserve the relevant factual fields from the real official responses; full 70-pairing capture is retained. Tests cover those dates, verified empty, calendar/fixture pagination, untrusted next links, wrong-tournament rows, adjacent dates, unknown times, placeholders, partial evidence, repeated pages, failures, cancellation, timeout, and year boundaries.

## Remaining limitation

The official publisher currently exposes no named Swiss main-event pairings for 9 October through the examined public sources. The fix correctly discovers the event and reports the coverage gap, and will consume published API pairings on a subsequent uncached retry. It cannot truthfully provide today's match-level player analysis until those pairings are available. Hosted execution still needs a deployment smoke test; none was performed here.
