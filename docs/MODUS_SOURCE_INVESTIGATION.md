# MODUS fixture-source investigation

Investigated on 2026-08-08 with web search, the live website in a browser, and direct read-only HTTP requests.

## Primary: official MODUS daily feed

- Website: https://modussuperseries.com/
- Feed discovered in the official page's own `refreshHomeMatchCentre` script: https://modussuperseries.com/live-scores-json.php
- The JSON includes `date`, `sport_event.start_time`, competition metadata, competitors, and status.
- It is the highest-confidence source and is used first.
- Limitation: query-string date parameters are ignored; the endpoint returns the site's current daily slate only. It cannot answer arbitrary future or historical dates.
- The feed uses Sportradar-style names such as `Beveridge, Darren`; these are canonicalized and resolved against DartsOrakel. Placeholder competitors such as `Winner Group 1` and `Runner Up Group 2` are excluded.

The official results page at https://modussuperseries.com/results was also inspected. It exposes series/week/group results and match detail pages, but not a simple arbitrary-date fixture API. Individual match pages do include date/time.

## Fallback: Darts Nerd fixture provider

- Public future-fixture page: `https://www.darts-nerd.com/en/matches/preview`
- Public season page for today and historical fallback: `https://www.darts-nerd.com/en/federations/modus/super-series/{year}/matches`
- The pages are server-rendered and expose each fixture time as an ISO `data-utc` attribute. The preview page is global, so only links under the MODUS federation path are accepted.
- Its public `robots.txt` permits the public HTML pages and explicitly disallows `/api/`, so the implementation reads only the allowed HTML and does not probe or use private API routes.
- The provider published the 2026-08-10 Monday slate before the official daily feed switched to that date.
- Display names are abbreviated (`van Peer B.`). The code resolves them uniquely against DartsOrakel's player directory. Ambiguous or missing mappings are retained as provider labels so one unavailable form lookup cannot hide the rest of the scheduled roster.
- Limitation: the annual page is large (about 1.4 MB during investigation) and third-party freshness is not guaranteed. It is cached for six hours and used only after the official source cannot answer the requested date.
- Upcoming results use a 30-minute cache because the preview roster can change before the session begins.

## Rejected options

- Flashscore indexed the competition and upcoming fixtures, but its client-heavy/anti-bot delivery is not used. No bypass or private endpoint probing was attempted.
- Betting feeds and social posts were rejected as lower-confidence and unstable.
- The official site's upstream Sportradar credentials are server-side and were not sought or bypassed.

## Source policy

1. official current-day JSON feed;
2. allowed public Darts Nerd preview HTML for future dates, otherwise season HTML;
3. structured `ModusSourceUnavailableError` listing every source failure.

Successful date results are cached. A source returning zero fixtures is not treated as a successful empty event; the fallback is attempted, and total absence is reported rather than guessed.
