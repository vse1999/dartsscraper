# DartsOrakel investigation report

Investigation date: 2026-08-08

## 1. How match data is served

The page `https://dartsorakel.com/player/matches/13/damon-heta` renders the table shell in HTML and fills the rows with DataTables. Its inline DataTables configuration contains the exact public request:

```txt
GET https://dartsorakel.com/api/player/matches/{playerId}
```

The response is JSON with the shape `{ draw, recordsTotal, recordsFiltered, data }`. Each `data` row contains the fields used by the table, including `match_date`, `tournament_name`, `tournament_no`, `round`, `result`, `opponent`, `score`, and `stat`. The `opponent` value is an HTML anchor string; the visible player name is the anchor text. The selected `Averages` stat is returned in `stat`.

The match page also passes the discovered `dateFrom`, `dateTo`, `rankKey`, `organStat`, and `tourns` query parameters to the same endpoint. The complete default Averages view uses `rankKey=25`, `organStat=All`, and an empty `tourns` value. `organStat=All` is semantically required: omitting it does not produce an API error, but silently returns only a subset of competitions for some players. For example, Rob Cross returned 629 historical rows without it and 1,311 rows with it; the smaller response omitted World Matchplay and European Tour matches from the latest results.

The implementation uses the endpoint directly, sends those observed default filter values, and supplies a wide date range (`1900-01-01` through tomorrow) so retired players such as Robert Thornton are not lost behind the page's default one-year date range. Match-cache keys include a schema/filter version so responses cached under an older incomplete query cannot mask corrected live data.

The wider all-competition response also exposed legitimate repeated matchups within the same event: Robert Thornton played Jake Jones twice on the same day, in the same round, with the same 4–3 score, but with different underlying stat totals and averages. A fingerprint based only on event, players, date, round, and score incorrectly treated those as conflicting duplicates. Match identity now includes the API's underlying `stat1` and `stat2` values, preserving distinct repeated matches while still removing exact duplicate rows.

## 2. Player-resolution mechanism

The site's `Player Stats` page is backed by the exact public request:

```txt
GET https://dartsorakel.com/api/stats/player
```

Its rows contain `player_key`, `player_name`, and `player_profile_url`. The profile URL observed for Robert Thornton is:

```txt
https://dartsorakel.com/player/details/73/robert-thornton
```

The resolver fetches this structured player list, normalizes the requested name with Unicode NFKC normalization, whitespace collapsing, and case folding, then requires exactly one normalized exact match. It derives the slug from the observed profile URL instead of hardcoding IDs. Zero matches produce `PlayerNotFoundError`; multiple normalized matches produce `PlayerAmbiguousError`.

## 3. HTTP/API versus Playwright

The API is public, structured, and sufficient for both player resolution and match extraction. Native `fetch` is therefore the primary implementation. Playwright is not needed in production for the current site structure; it would add browser startup and rendering cost without improving extraction reliability. The parser remains isolated so a future browser fallback can be added if the endpoint disappears.

## 4. Pagination behavior

The match page configures DataTables with `serverSide: false` and `pageLength: 50`. The API returns the full filtered `data` array, while the browser paginates it locally. The player stats page behaves the same way. The scraper therefore does not guess page numbers or scrape visible rows; it validates and processes the complete JSON response.

## 5. Proposed extraction contract

```ts
type Match = {
  date: string;
  tournament: string;
  round: string | null;
  result: string;
  opponent: string;
  score: string;
  average: number | null;
};
```

The service resolves a player, fetches validated match rows, removes bye/incomplete rows, converts dates and anchor text deterministically, removes duplicate match identities, sorts newest first, and returns at most the requested limit. Missing averages become `null`; missing required fields or an invalid response raise a structure-change error rather than producing guessed data.

## Access and operational notes

On investigation, `https://dartsorakel.com/robots.txt` returned `User-agent: *` and `Disallow:`. The implementation still uses a descriptive User-Agent, a timeout, bounded retries, deterministic backoff, and a minimum request interval. It only calls the observed public endpoints and does not bypass authentication, anti-bot controls, or access restrictions. Local caches are optional and use a long TTL for player identity data and a short TTL for match data.

