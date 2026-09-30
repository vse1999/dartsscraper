# Player identity hardening

## Implemented behavior

### Odds comparisons

1. Preserve the displayed home/away odds slots and source event ID.
2. Read that event's exact public Eredmenyek match detail; verify its date and full participant names.
3. Verify both public player profile pages using matching name headings and canonical profile IDs. URL slug order is not participant order.
4. Cross-check detail links against verified profiles, then join full names to exactly one DartsOrakel directory identity.
5. Quarantine conflicting IDs, reject mismatched evidence and leave missing/ambiguous identities unresolved. Do not retain a unique abbreviated directory guess when source verification fails.

The source-ID/name conflict cache is process-local, not a durable database. No fuzzy guessing, popularity selection, AI identity inference, paid API or new infrastructure was added.

### MODUS

- Shared fixture matching handles ordered names, diacritics, punctuation, compound initials and junior suffix spelling.
- Conflicting directory IDs and ambiguous fixture abbreviations are rejected.
- Official history requests resolve against the complete retrieved catalogue before fetching match details. A unique abbreviation can resolve; an ambiguous abbreviation cannot mix histories.
- Full history requests do not attach to abbreviation-only catalogue rows. Generic token sorting/reversal is forbidden. Surname-first spelling is accepted only while validating the same official match ID, never as an alias across matches.
- Explicit MODUS statistics requests remain official-source requests; no silent DartsOrakel fallback was added.

## Independent verification on 2026-09-30

The main agent ran actual read-only public-source commands, separately from the coding agents. No Telegram messages were sent.

| Check | Observed result |
| --- | --- |
| `npm run build` | Passed |
| `npm test -- --maxWorkers=2 --minWorkers=1` | 560 tests passed across 61 files |
| Corrected identity guard tests, independently rerun | 10/10 passed; invalid-date and invalid-profile cases preserve the event ID to isolate those guards |
| `npm run audit:prod` | Zero reported production vulnerabilities |
| `scripts/odds-identity-smoke.ts today` | 4/4 source matches, 8 participant identities verified; Ross Smith confirmed as `l8mIsYNm`; 12,888 ms |
| `scripts/odds-identity-smoke.ts tomorrow` | 4/4 source matches, 8 participant identities verified; Luke Humphries confirmed as `n34VOAWo`; 11,254 ms |
| `scripts/value-smoke.ts today` | Odds observed `2026-09-30T14:39:03.342Z`; 4 cards, all complete, 8 resolved players, no unresolved players; 90,934 ms |
| `scripts/value-smoke.ts tomorrow` | Odds observed `2026-09-30T14:24:19.921Z`; fixture date `2026-10-01`; 4 cards, all complete, 8 resolved players; 103,749 ms |
| `scripts/modus-all-players-smoke.ts` after final ambiguity fix | 79 official catalogue-name queries passed, zero failed |

The MODUS smoke checks preserved query identity/source, returned player-name equality, official provider, 1–10 completed matches and aligned official evidence URLs. The 79 names were discovered on retrieved catalogue pages; this is not a claim that 79 players were playing that day or that every historical player was tested.

Regression coverage includes reversed detail URL order, swapped anchors, contradictory profile headings/IDs, conflicting duplicate labels, missing/wrong-date/profile evidence, cancellation, leading initials, canonical ID collisions, 13-card capacity overflow, ambiguous forced MODUS requests and unrelated reversed full names.

## Use

Existing owner-private-chat commands benefit automatically after deploying this code:

```text
/value today
/value tomorrow
Kai Fan Leung last 10 matches from MODUS
```

Prefer full names for manual requests. Existing MODUS fixture workflows reuse the shared resolver. `/value` still uses the canonical DartsOrakel directory and statistics: this change does not add an official-MODUS fallback for a player absent from that directory.

Local reproduction:

```powershell
$env:ODDS_BROWSER_EXECUTABLE_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node --import tsx scripts/odds-identity-smoke.ts today
node --import tsx scripts/value-smoke.ts today
node --import tsx scripts/modus-all-players-smoke.ts
```

Public evidence outputs are stored locally in ignored `.tmp/` files. They contain no credentials.

## Honest bounds

- Default source identity verification is limited to 12 candidate matchups and 45 seconds per lookup. Larger reports retain all cards, disclose the capacity bound, and do not guess unverified abbreviated players. A lookup timeout can leave all abbreviated candidates unresolved.
- Source changes, unavailable profiles, same-name people or absent directory players can still prevent identification. Passing these cases is not proof of universal 100% future accuracy or coverage.
- The intended safety contract is abstention instead of attaching uncertain statistics; tests do not certify that upstream websites never publish incorrect data.
- Production Linux browser execution and actual Telegram delivery were not exercised here. Deployment remains necessary; this task did not commit, push or deploy.
