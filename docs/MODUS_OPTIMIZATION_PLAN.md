# Official MODUS data optimization plan

## Problem statement

The original chatbot interpreted a request such as “today MODUS all matches and player averages” as:

1. discover today's MODUS participants;
2. resolve every participant through DartsOrakel;
3. calculate each participant's mean over their latest DartsOrakel matches.

That workflow answers a different question. DartsOrakel is appropriate for PDC and cross-event player history, but its MODUS rows may arrive days later. It cannot be the primary source for same-day MODUS scores or official averages.

## Verified official contracts

The official website exposes three complementary public sources:

| Source | Purpose | Freshness |
|---|---|---|
| `https://modussuperseries.com/live-scores-json.php` | Current daily slate, status, scores, start time, and per-player match statistics including `average_3_darts` | The official page polls it every five seconds with `cache: no-store` |
| `https://modussuperseries.com/results.php` | Selected current series, week, group, completed result cards, and the official weekly-average link | Server-rendered current state |
| `https://modussuperseries.com/week-averages.php?series_id=…&week_id=…` | Official cumulative week table: position, player, matches played, points, darts, and average | Updated as official results are imported |

Individual `match-db-stats.php?match_id=…` pages expose the same per-match averages and deeper checkout statistics. They are a useful verification surface, but the daily JSON already provides every current-day match average in one request, so the production path should avoid an N+1 detail-page crawl.

## Source precedence

1. **Current/latest MODUS scores and averages:** official MODUS daily JSON and weekly averages page.
2. **Current/future MODUS participant discovery:** official daily JSON, then the allowed public Darts Nerd fixture page.
3. **PDC and explicitly requested cross-event last-N history:** DartsOrakel.
4. Never silently replace missing official same-day MODUS data with older DartsOrakel matches.
5. Preserve unavailable official values as `null` and report partial freshness explicitly.

## Target snapshot

One deterministic `getModusResults({ date })` call returns:

- official date and feed generation time;
- selected series, week, and group;
- every daily match in official order;
- scheduled/live/completed status;
- both players and scores;
- both official per-match three-dart averages when available;
- the official cumulative weekly average table;
- direct source URLs and parser warnings.

Aggregate and match metrics remain distinct:

- **Match average:** one player's official three-dart average in one match.
- **Cumulative weekly average:** official total points divided by darts and multiplied by three.
- **DartsOrakel last-N mean:** arithmetic mean of stored match averages across explicitly requested historical matches.

The chatbot must label these scopes instead of calling all three “player average.”

## Implementation phases

### Phase 1 — strict source boundary

- Add Zod schemas dedicated to official MODUS result snapshots.
- Parse the daily JSON without DartsOrakel name resolution.
- Canonicalize official `Surname, Firstname` display names.
- Match statistics to competitors by official ID or qualifier, never by unverified array order.
- Parse selected series/week/group and the weekly-average URL from official HTML.
- Verify each reported cumulative average against `points / darts * 3` within rounding tolerance.
- Fail with the exact source URL and structural reason when the public contract changes.

### Phase 2 — freshness and performance

- Use one daily JSON request, one context request, and one weekly-average request.
- Avoid per-match detail requests in the normal path.
- Use `cache: no-store` for the daily feed.
- Store a schema-versioned snapshot for no more than 15 seconds.
- Reuse one source/service instance per chatbot process.
- Keep the existing longer-lived fixture cache separate from current result data.

### Phase 3 — deterministic agent routing

- Add `getModusResults` as a first-class tool.
- Classify current/today/latest MODUS result, score, match-average, overall-average, and “all matches” requests as official-result intent.
- Force one official bulk call even when Gemma initially chooses the old participant/DartsOrakel path.
- Keep old last-N tools available only for explicitly requested history.
- Prevent repeated identical calls and DartsOrakel fan-out for official-result intent.

### Phase 4 — evidence validation

- Require every official match to appear once with both players, score, and available match averages.
- Require every cumulative weekly average to appear with its official scope.
- Require the requested ISO date and official provenance.
- Reject omissions, changed values, invented players, and substituted DartsOrakel statistics.
- Fall back to a deterministic complete renderer after repeated invalid model drafts.

### Phase 5 — regression and live verification

- Fixture-test complete, live, scheduled, missing-statistic, malformed, and date-mismatch cases.
- Test cumulative-average arithmetic consistency.
- Test cache key and short TTL.
- Test that the screenshot query executes exactly one official MODUS tool.
- Test that explicit DartsOrakel last-N and Rob Cross PDC behavior remain unchanged.
- Compare live tool output with `results.php`, `week-averages.php`, and a representative match detail page.
- Run the exact question through Ollama/Gemma and the browser chatbot.

## Operational safeguards

- Bind the chatbot to `127.0.0.1` by default.
- Keep request, model-turn, tool-call, timeout, and session-history limits.
- Do not expose raw source HTML or hidden model reasoning.
- Log source URL, duration, result count, and failure code without logging prompts or secrets.
- Treat a changed official schema as an explicit source failure, never as an empty successful day.
- Keep source links and feed timestamps in the final answer so the user can assess freshness.

## Acceptance criteria

The change is complete only when:

1. “today darts modus all matches and player averages” returns all official daily matches;
2. every completed row includes both official per-match averages;
3. the answer includes official cumulative weekly averages separately;
4. the tool trace contains `getModusResults` and no per-player DartsOrakel fan-out;
5. the date, players, scores, averages, and sources match the live official pages;
6. malformed/partial official data produces an actionable warning or error;
7. TypeScript, all tests, production audit, CLI smoke tests, and browser tests pass.
