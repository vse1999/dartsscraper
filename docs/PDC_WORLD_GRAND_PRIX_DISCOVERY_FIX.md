# World Grand Prix fixture discovery: 2026-09-28

## Confirmed cause

The screenshot's `/pdc tomorrow` correctly resolves to 2026-09-28 in
Europe/Budapest. The failure is fixture extraction, not relative-date resolution
or a missing World Grand Prix tournament allowlist.

The production upcoming pipeline uses PDPA's calendar and event pages, then
Darts Nerd for corroboration and match times. It does not use the OddsPortal or
Eredmenyek tomorrow pages supplied in the report.

Live inspection of https://pdpa.co.uk/events/calendar/ confirmed a World Grand
Prix event starting September 28. The event page at
https://pdpa.co.uk/event/world-grand-prix-2026/ contains:

- **Entries:** the dated schedule, including eight Monday matches and eight
  Tuesday matches, followed by unresolved later-round pairings.
- **More Information:** an undated 16-match draw bracket.

`parsePdpaEventFixtures` selected only the first “More Information:” content
section. It requires a matching date heading before accepting a matchup, so
the undated bracket correctly yielded no matches—but the actual schedule in
Entries was never inspected.

`CorroboratedPdcFixtureSource` returns immediately when PDPA produces zero
fixtures. Consequently the live preview was never consulted, even though its
September 28 rows contained the World Grand Prix matches. This guard is
intentional: the live preview also contains MODUS and is not independently
safe to treat as PDC-only.

The service cached the empty fixture array for five minutes. The formatter
then rendered “No scheduled PDC match was found for this date.” No player-form
lookups were necessary because the fixture list was already empty.

## Fix and safety boundaries

- Inspect every event information content section for dated schedules rather
  than relying on one editorial heading.
- Reset date, round, and session state at each section boundary. An undated
  draw in a subsequent section cannot inherit a schedule date.
- Preserve date filtering, concrete-player checks, and fixture deduplication.
- Preserve the official-source gate; do not introduce an unverified live-feed
  fallback or hardcode tournament dates, names, or pairings.
- Advance the fixture cache namespace from v4 to v5 so a new deployment does
  not reuse the old parser's cached empty result.

## Regression evidence

The captured event-information HTML in the test fixtures reproduces the
failure: all five new regression tests failed before the parser change.
Afterward they pass, covering Monday's exact eight pairings, Tuesday's separate
schedule, unresolved rounds, independent section state, duplicated schedules,
and calendar-to-live-source orchestration. Existing More Information-based
schedule tests remain passing.

TypeScript build and the full local suite pass (49 files, 413 tests).

The read-only live `npm run pdc:upcoming:smoke -- 2026-09-28` also passes:
eight World Grand Prix fixtures, all corroborated by the live feed; 16 unique
players with ten completed matches each; all 160 history rows include 180 and
checkout metrics; 17 formatted Telegram messages, maximum 3,457 characters.
The check generates messages locally but does not send them. Ambiguous live
Smith abbreviations produce warnings; the official fixture context correctly
resolves Ross Smith, and unrelated MODUS rows are excluded.

## Remaining limitations

PDPA remains required to publish concrete, dated pairings. This change does not
infer a day from an undated draw, invent later-round opponents, or guarantee
compatibility with future site markup changes. Production requires deployment
of the updated code; this investigation does not deploy or send Telegram
messages.
