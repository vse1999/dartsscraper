# Agent tool contracts

All tool results use `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message" } }`.

## `resolveDate`

Input: `{ "expression": string }`

Output: `{ "date": "YYYY-MM-DD", "resolvedFrom": "explicit|relative|weekday", "timeZone": "Europe/Budapest" }`

## `getModusPlayers`

Input: `{ "date": "YYYY-MM-DD" }`

Output:

```json
{
  "event": "MODUS Super Series",
  "date": "2026-08-10",
  "players": [
    { "name": "Ryan Branley", "source": "https://...", "confidence": 1 }
  ]
}
```

Names are deduplicated after Unicode/case/whitespace normalization. `confidence: 1` means the participant was explicitly present in the selected fixture source, not inferred by the LLM.

## `getModusResults`

Input: `{ "date": "YYYY-MM-DD" }`

Output: one validated official snapshot containing the feed date/timestamp, selected series/week/group, every daily match, both scores, both per-match three-dart averages when published, the cumulative weekly average table, direct source URLs, and warnings.

This is the authoritative bulk tool for current/today/latest MODUS results. Missing values remain `null`. It never fills gaps from DartsOrakel. A requested date that differs from the official daily feed date is an explicit error.

## `getPlayerMatches`

Input: `{ "player": string, "limit": integer 1..1000 }`

Output: the existing validated `MatchResult` plus backward-compatible `meanMatchAverage` and a deterministic `summary`. DartsOrakel match rows contain nullable `average`, `oneEighties`, `checkoutPercentage`, `checkoutHits`, and `checkoutAttempts`. `summary` contains record, mean/best average, complete 180 total, weighted checkout conversion, raw checkout counts, and per-metric coverage. This tool is intended for requests that need individual match rows.

## `getPlayerMatchAverage`

Input: `{ "player": string, "limit": integer 1..1000 }`

Output:

```json
{
  "player": "Ryan Branley",
  "requestedLimit": 10,
  "matchCount": 10,
  "average": 79.16,
  "totalOneEighties": 6,
  "checkoutPercentage": 39.39,
  "checkoutHits": 26,
  "checkoutAttempts": 66,
  "coverage": { "average": 10, "oneEighties": 10, "checkout": 10 }
}
```

`average` is the arithmetic mean of available DartsOrakel match-average values, rounded to two decimals. `totalOneEighties` is `null` unless every selected match has 180 data. `checkoutPercentage` is the ratio of total successful checkouts to total attempts, rounded once to two decimals; it is never an unweighted mean of match percentages. Zero attempts produce `null`. Coverage makes partial upstream availability explicit. `matchCount` is the actual number of completed matches returned and may be below the requested limit.

## Error codes

- `UNKNOWN_TOOL`: the model requested a tool that is not registered.
- `INVALID_ARGUMENTS`: Zod rejected malformed arguments.
- `TOOL_FAILED`: the official source, player resolution, DartsOrakel request, or deterministic operation failed.

Failures stay in the conversation as tool evidence so one unavailable player does not discard successful players.
