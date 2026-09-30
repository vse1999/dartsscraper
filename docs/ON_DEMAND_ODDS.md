# On-demand Telegram odds: implementation and verification

Updated: 2026-09-30. Scope amendment: the owner explicitly requested live read-only collection from OddsPortal and/or Eredmenyek. This slice connects an on-demand odds viewer; it does not activate the autonomous watchlist plan.

## Smallest useful workflow

1. Owner requests `/odds today` (or `/odds tomorrow`) in the existing private bot.
2. An isolated browser loads the corresponding Eredmenyek darts odds page using ordinary rendering.
3. The collector reads displayed scheduled match-winner rows, with both selections attributed to the same verified bookmaker.
4. The bot shows player labels, prices, competition, Budapest schedule, source and observation time. The owner can then use the existing `/compare Player One, Player Two last 10` command with full player names.

No bookmaker links are followed, no betting accounts are used, and no wagers or automatic value alerts are generated. This is data retrieval, not a win-probability model.

## Evidence that selected the source

The initial inspection below was on 2026-09-28; its row counts are historical. Current application-level checks are recorded separately below.

- Ordinary HTML GETs returned HTTP 200 for both requested sites, but did not contain the rendered odds rows. An HTML success status alone is insufficient.
- The OddsPortal browser listing displayed an application error during this inspection; it is not implemented as a silently substituted fallback.
- Eredmenyek's ordinary browser page displayed World Grand Prix and MODUS matches. Today's capture contained seven scheduled World Grand Prix rows, one live row and fifteen finished MODUS rows. Tomorrow's capture contained eight World Grand Prix and fifteen MODUS scheduled rows. Counts are observations, not coverage guarantees.
- Both displayed odds cells carried bookmaker ID `498`; the public page's bookmaker settings identify this as TippmixPro. Mapping is source-specific and must not be inferred from price alone.
- Displayed player order can differ from match URL slug order. The displayed home/away labels, not URL order, own selection mapping.
- The selected date is explicitly available in the day-picker accessibility label, including year. A browser context using Europe/Budapest is required for schedule interpretation.
- Direct unauthenticated requests to the page's data feeds returned HTTP 401. No header/token replay, access-control bypass, proxy rotation or CAPTCHA solving was used. The implementation uses ordinary rendered-page access instead.

These observations establish technical behavior, not legal permission, source availability in every hosting region, or guaranteed free hosting. Public visibility alone does not settle usage conditions.

## Implementation boundaries and acceptance

- One source, today/tomorrow only; no arbitrary user URLs, new scheduler or database.
- Opt-in `ODDS_FETCH_ENABLED=true`; source outages must not break existing statistics commands.
- Lazy browser startup; standard Playwright and bundled serverless Chromium, with an explicit local executable option.
- Fixed navigation targets, constrained subresources, bounded runtime, cancellation and browser cleanup.
- Five-minute in-process cache preserves original observation time; it is neither distributed rate limiting nor a billing cap.
- Only scheduled, valid two-outcome rows with matching bookmaker IDs qualify. Unknown dates, malformed prices, live/finished rows and ambiguous identities must not become valid observations.
- Provider errors, loading shells and blocked requests must be distinct from a successfully loaded page with no matching odds.
- Owner/private-chat authorization precedes all collection. Reuse the existing report lifecycle and Telegram delivery policy.
- No threshold changes, automatic statistical joins, customer publication, paid APIs, cloud provisioning or production deployment in this slice.

## Execution

Application and test coding is assigned to two Luna 5.6 XHIGH agents with disjoint write scopes: source/browser adapter, and Telegram workflow. Main-agent responsibilities are source inspection, interface agreement, review and independent verification. No nested delegation.

## Independent application-level live evidence

On 2026-09-30 the main agent ran the actual `scripts/odds-smoke.ts` collector with Playwright and an isolated installed Chrome, not a pre-existing browser session or saved fixture:

- `today`: observed at `2026-09-30T12:09:56.217Z`, date `2026-09-30`, six eligible upcoming TippmixPro matches; thirteen finished rows excluded. Example: Noppert D. / Joyce R., 20:10 Budapest, 1.55 / 2.38.
- `tomorrow`: observed at `2026-09-30T12:09:57.990Z`, date `2026-10-01`, four eligible World Grand Prix matches. Example: Zonneveld N. / Anderson G., 20:10 Budapest, 2.70 / 1.44.

These are historical price observations, not current betting prices. No Telegram message was sent. An earlier application smoke failed the bookmaker-mapping check; the collector was corrected to validate the actual same-object public mapping instead of relying on an obsolete availability substring.

### Final verification

- Independent live collector rerun: `2026-09-30T12:18:38.933Z` (today, six matches) and `2026-09-30T12:18:40.638Z` (tomorrow, four matches), both exit 0.
- `npm run build`: passed.
- `npm test -- --maxWorkers=2 --minWorkers=1`: 500 tests passed across 56 files. Includes mocked browser-reader integration, strict source parsing, queue cancellation, cache/date guards, cleanup and Telegram authorization/delivery regression tests.
- `npm run audit:prod`: zero reported production dependency vulnerabilities.
- Final review caught and fixed queued-abort timeout behavior and a pre-aborted queue promise hang, with regression tests. Later-page Telegram delivery uncertainty preserves the already-delivered first page.
- No commit, push, deployment or live Telegram send was performed for this implementation.

## How to use

After deploying the updated code, set `ODDS_FETCH_ENABLED=true` in the bot's deployment environment and redeploy with that setting. In the owner's private Telegram chat:

```text
/odds today
/odds tomorrow
/compare Danny Noppert, Ryan Joyce last 10
```

`/odds` defaults to today. The comparison above is an illustrative workflow, not an automatically linked recommendation. Source labels may be abbreviated; resolve full player identities manually before using `/compare`.

For a local read-only smoke in PowerShell, from the repository root:

```powershell
$env:ODDS_BROWSER_EXECUTABLE_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node --import tsx scripts/odds-smoke.ts today
node --import tsx scripts/odds-smoke.ts tomorrow
```

On Linux serverless, the bundled Chromium package supplies the executable. Its binary assets must be included in the webhook function bundle. Windows/local use requires an installed executable configured explicitly.

## Operational limitations

- The current source is Eredmenyek, with displayed TippmixPro two-outcome match-winner prices only. OddsPortal fallback, 180/checkout markets and automatic value screening are not implemented in this slice.
- Output reflects visible source coverage, not a guarantee of every PDC market or bookmaker. Live, finished, ambiguous and malformed rows are excluded. Site structure and regional availability can change.
- The five-minute cache is per process and preserves observation time; it is not a global quota ledger or proof of free hosting. No paid scraper or API is used, but hosting capacity and billing remain account-specific.
- Local Chrome live fetching has been verified. The deployed Linux/Vercel runtime and actual Telegram delivery of this new command require a separate production smoke. No production deployment, account change or live Telegram send was performed here.
- Automatic scheduled alerts, durable delivery state and statistical matching remain separate work. This viewer must not be represented as the completed autonomous watchlist.

## Runtime references

- [Playwright browser documentation](https://playwright.dev/docs/browsers).
- [Serverless Chromium supported usage](https://github.com/Sparticuz/chromium): browser binaries and memory must fit the host; local Chrome and serverless Chromium are different runtimes.
- [Vercel function limits](https://vercel.com/docs/functions/limitations): deployment size and runtime capacity must be checked on the actual project. No account quota or zero-charge entitlement has been verified here.
