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

## `getPlayerMatches`

Input: `{ "player": string, "limit": integer 1..1000 }`

Output: the existing validated `MatchResult` plus deterministic `meanMatchAverage`. This tool is intended for requests that need individual match rows.

## `getPlayerMatchAverage`

Input: `{ "player": string, "limit": integer 1..1000 }`

Output:

```json
{
  "player": "Ryan Branley",
  "requestedLimit": 10,
  "matchCount": 10,
  "average": 79.16
}
```

`average` is the arithmetic mean of available DartsOrakel match-average values, rounded to two decimals. It is `null` when no returned match has an average. `matchCount` is the actual number of completed matches returned and may be below the requested limit.

## Error codes

- `UNKNOWN_TOOL`: the model requested a tool that is not registered.
- `INVALID_ARGUMENTS`: Zod rejected malformed arguments.
- `TOOL_FAILED`: the source, player resolution, DartsOrakel request, or deterministic operation failed.

Failures stay in the conversation as tool evidence so one unavailable player does not discard successful players.
