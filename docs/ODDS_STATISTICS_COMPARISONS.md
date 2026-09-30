# On-demand odds and statistics comparisons

## Approved scope

`/value today` and `/value tomorrow` prepare research, not recommendations. `/value` defaults to today. Every eligible matchup collected by the existing Eredmenyek/TippmixPro odds reader remains in the report, in source order. This is visible source coverage, not a complete bookmaker/PDC inventory.

The report includes displayed odds, observation time, resolved player names, last-10/20 averages, weighted checkout totals, metric coverage, and statistics source links. Player history is requested once per resolved identity per report; both windows come from the same history. Incomplete history or statistics are disclosed. No personal notes, thresholds, ranking, probability estimates, automatic alerts or wagering are introduced.

## Architecture and boundaries

- `src/value/`: typed contracts, strict source-name matching, directory adapter, bounded research and window calculations.
- `src/telegram/value-command.ts`: existing authorized background report lifecycle and safe delivery.
- `src/telegram/value-formatter.ts`: descriptive cards and bounded multi-message output.
- Existing odds reader, paced bulk player statistics service, public directory transport and authorization are reused. No new dependency, database, cron or paid API is added by this comparison feature.
- Exact canonical full-name joins only after verifying abbreviated odds names against the source match detail and player profiles. The production reader does not retain unverified abbreviation guesses. Conflicting source IDs are quarantined. Both odds slots resolving to one identity cannot become a comparison. See `docs/PLAYER_IDENTITY_VERIFICATION.md` for the identity flow, live evidence and bounds.
- Odds collection and history enrichment share a 210-second soft research deadline; the command uses a 240-second research limit and 270-second total limit. A history deadline preserves odds cards with explicit unavailable/timeout states. Odds acquisition failure remains a source failure, not an empty result.
- Checkout percentage is total valid hits divided by total valid attempts, with coverage counts. Missing values remain unavailable. Known zero-attempt rows contribute to coverage but do not create a percentage with zero denominator.
- Stage and upcoming match format currently remain explicitly unknown: no authoritative context adapter has been connected. No inference from tournament names is represented as verification.
- History requests may be satisfied by existing caches. Report generation time does not prove when the source last updated its statistics.
- Directory caching and player-request deduplication are process/report-local, not distributed quotas. Rate limits, hosting limits and source availability still apply.

## Independent live verification: 2026-09-30

The main agent ran the actual public odds collector and comparison service using isolated local Chrome, without sending Telegram messages:

- Command: `node --import tsx scripts/value-smoke.ts today`.
- Odds observed at `2026-09-30T13:21:12.410Z`.
- Four collected matchups, four retained cards: three complete comparisons and one unresolved comparison; seven resolved identities and one unresolved player appearance.
- Runtime: 73,636 milliseconds. This is one observation, not a latency guarantee for larger lists.
- Example: Danny Noppert / Ryan Joyce at displayed odds 1.55 / 2.38. Last-10 averages: 97.25 / 90.65; weighted checkouts: 51/119 (42.86%) / 51/108 (47.22%). Last-20 averages: 95.91 / 90.69; weighted checkouts: 101/233 (43.35%) / 98/222 (44.14%). These are historical observations, not current odds or tips.
- `Smith R.` remained unresolved rather than being attached to a guessed player.
- Independent tomorrow smoke: odds observed at `2026-09-30T13:26:39.958Z`, fixture date `2026-10-01`; four odds matchups/four cards, three complete and one unresolved comparison, seven resolved identities; runtime 83,272 milliseconds. Example: Niels Zonneveld / Gary Anderson, displayed odds 2.70 / 1.44, last-10 averages 95.69 / 96.78 and weighted checkout 51/129 (39.53%) / 71/160 (44.38%).

## Comparison baseline verification (before identity hardening)

- `npm run build`: passed.
- `npm test -- --maxWorkers=2 --minWorkers=1`: 530 tests passed across 58 files, including 19 backend research cases and 11 new Telegram workflow cases.
- `npm run audit:prod`: zero reported production vulnerabilities.
- `git diff --check`: passed. New comparison source/test files were also inspected for trailing whitespace and explicit TypeScript `any` types.
- Independent review corrected surname-first initials, full-name fallback ambiguity, non-cooperative provider deadlines, malformed-history handling and false zero totals. Regression tests also verify weighted checkout, both windows from one history, no metric backfill, duplicate/future/live exclusion, same-identity rejection and partial-card retention.

## Enable and use after deployment

Reuse `ODDS_FETCH_ENABLED=true` in the deployment environment, then redeploy the updated code. The owner's private Telegram chat can request:

```text
/value today
/value tomorrow
```

The existing `/odds` viewer and manual `/compare` remain available. A partial report means some cards lack verified statistics; it does not mean those cards were silently discarded.

Local PowerShell smoke:

```powershell
$env:ODDS_BROWSER_EXECUTABLE_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node --import tsx scripts/value-smoke.ts today
node --import tsx scripts/value-smoke.ts tomorrow
```

## Release limitations

The deployed Linux browser runtime and actual Telegram delivery require a separate production smoke. Large lists may reach the enrichment or delivery deadline. No unlimited/free-forever hosting guarantee is made. HTTP request counts have not been independently instrumented; tests verify per-report identity deduplication rather than claiming one HTTP request per player.

No commit, push, deployment, account change or live Telegram send is authorized or performed by this implementation task.
