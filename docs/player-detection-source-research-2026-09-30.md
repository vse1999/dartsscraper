# Player detection: source research

Date: 30 September 2026 (Europe/Budapest). Research only; no runtime, feature, command, parser, configuration, or behavior changes.

## Executive decision

Improve **identity evidence and recovery**, not the quantity of scraped websites. A second fixture provider does not solve missing identities if both providers must resolve names through the same DartsOrakel statistics directory. Preserve conservative ambiguity handling and current source precedence until separately approved implementation.

The most valuable near-term work is a shadow-tested identity catalogue combining existing official MODUS match references, existing DartsOrakel profile links, and reviewed official PDC names/nicknames. DartConnect is a valuable next-source feasibility study, not a verified drop-in API.

## What the bot already has

Repository evidence, inspected read-only:

- `src/player/resolver.ts`: DartsOrakel `getPlayerStats()` directory; exact, unique token-phrase, and bounded fuzzy resolution; fuzzy distance/score/margin gates and ambiguity errors. Successful directory promises remain cached for the resolver lifetime; no refresh TTL is present here.
- `src/modus/fixture-name-resolver.ts`: the same statistics directory for full names and unique trailing-initial abbreviations; safeguards quarantine conflicting source IDs. This resolver is stricter than the general player resolver.
- `src/agent/factory.ts`: official MODUS feed followed by Darts Nerd, both given the same `FixtureNameResolver`. These are already implemented; adding them is not a new-source proposal.
- `src/modus/official-results-source.ts`, `src/modus/history-source.ts`, `src/modus/results-index-source.ts`, and `src/modus/player-history-service.ts`: official results, weekly averages, historical match-detail/index support, and live catalogue refresh already exist. Historical lookup has a current-series gate unless forced; the owner audit should evaluate actual caller routing before proposing gate changes.
- `src/pdc/default.ts`, `src/pdc/source.ts`: DartsOrakel event calendar and tournament results with embedded player IDs/profile links; PDPA event schedules plus corroborated Darts Nerd fixtures already exist.
- `src/dartsorakel/selectors.ts`: statistics directory `/api/stats/player`, player match endpoint `/api/player/matches/{id}`, and player profile pattern `/player/details/{id}/{slug}` are existing dependencies, not newly discovered documented public APIs.

**Product implication:** fixtures, identity, and statistics coverage are separate problems. A recognized official participant can legitimately lack DartsOrakel statistics. A fixture fallback can succeed while identity resolution still fails. Do not label both cases “player does not exist.”

## Verified source opportunities and limits

### 1. Existing MODUS official results: reuse identity context

The official results interface exposes series/week/group selection, participant names, results and tables. These are already consumed by the repository. Reuse parsed references as identity evidence rather than add a redundant scrape. Keep identity provenance scoped to series/week/group and observed time; the presence of an opponent is useful corroboration but not a globally unique identity key. [Official MODUS results](https://modussuperseries.com/results).

**Critical collision:** the official website explicitly uses **Lee (ENG) Evans** on one archived final and **Lee (WAL) Evans** on another archived group page. Repository `src/modus/identity.ts` currently removes country qualifiers before name comparison. These qualifiers are useful identity evidence; discard them only for search, not for candidate identity. Treat this as a high-priority collision fixture and investigate downstream merging before changing behavior. [ENG example](https://modussuperseries.com/results?group=Final&series_id=26&week_id=192), [WAL example](https://modussuperseries.com/results?group=Group+C&series_id=14&week_id=174).

**Proposal:** enrich a candidate with original label, country qualifier, provider ID when genuinely available, source URL, observation date and event scope. If two candidates collapse to the same normalized name, preserve both until evidence disambiguates them. No cross-provider numeric IDs should be assumed equivalent.

### 2. PDC player profiles: official names and nickname evidence

Search-indexed official player content includes player names, nicknames and nationality filters: examples include Luke Humphries / Cool Hand, Michael van Gerwen / Mighty Mike and William O'Connor / The Magpie. This supports a reviewed alias catalogue and a spelling reference, not proof of complete worldwide coverage. [PDC players](https://www.pdc.tv/players).

**Access limitation:** direct browsing of `/players` redirected to `/players/` and exposed only a short shell, although indexed content was rich. Therefore HTML-only availability, pagination completeness, current roster freshness, profile IDs and unattended parser suitability were **not established**. Do not promise a working adapter from a search snippet. A later read-only feasibility spike must check actual public delivery, access terms, schema and completeness without bypassing controls.

**Proposal:** keep official nickname aliases distinct from typo aliases. A nickname can generate a candidate, but must not override same-name ambiguity or map unrelated people merely because the nickname is shared. Do not make full PDC-profile coverage a prerequisite for detecting MODUS entrants.

### 3. PDPA Tour Cards: roster corroboration, not canonical truth

The PDPA publishes a named 2026 Tour Card roster, separate from the calendar the bot already uses. This is an additional surface on an existing provider and useful corroboration of professional status. However the fetched page contains spelling discrepancies such as “Martin Schindle,” “Wesley Nijman,” and “Beau Greave,” compared with official PDC profile-list spellings. Its introduction also says holders “will be confirmed” despite a populated roster. [PDPA Tour Cards](https://pdpa.co.uk/event-entry/tour-cards/).

**Proposal:** use membership as contextual corroboration, not as a whitelist of valid players and not as an automatic source of permanent aliases. Compare disputed names against provider-linked profile records or a second official surface, with reviewed corrections and provenance. Non-card players and MODUS participants must not be rejected merely because they are absent.

### 4. DartConnect: strongest genuinely additional PDC fallback candidate

DartConnect identifies itself as the official PDC scoring app and describes live scoreboards/results. Its current product page lists Players Championship, Women's Series, Challenge and Development Tour coverage. [Official DartConnect product page](https://www.dartconnect.com/pdc-app-upgrade/), [DartConnect homepage](https://www.dartconnect.com/).

A first-party PDC event report explicitly routes match statistics to DartConnect and identifies its own Match Centre as the draw/results surface, independently corroborating the relationship. This is historical evidence of the integration, **not** proof of every 2026 event's availability. [PDC Players Championship 24 report, 25 August 2025](https://www.pdc.tv/news/2025/08/25/2025-players-championship-24-latest).

**Access limitation:** no documented unrestricted API, stable player-ID crosswalk, scraping permission, rate limit or unattended current-event parser was verified. A direct guessed `/pdc/` URL was inaccessible. The official “PDC on DCTV” landing page still contains 2020 schedules, so its publication/crawl freshness must not be confused with schedule freshness. [Historical DartConnect landing page](https://www.dartconnect.com/pdc-on-dctv/).

**Proposal:** investigate a bounded read-only adapter for public event draws/participant names first. Limit it to missing-player or primary-source-unavailable paths after approval. Distinguish event identity recovery from statistical metric fallback: adding its averages without checking denominators, period, format and corrections risks silently changing existing analysis.

### 5. PDC tournament/news surfaces: bounded confirmation fallback

The PDC tournament index includes major, ProTour and secondary-tour categories; PDC reports can contain player names and draw/results links. This is useful event-scoped evidence, especially for qualifiers absent from a core roster. [PDC tournament index](https://www.pdc.tv/tournament/cazoo-masters), [PDC event report example](https://www.pdc.tv/news/2025/08/25/2025-players-championship-24-latest).

**Proposal:** follow an official event page's actual links rather than invent endpoint URLs. Store event/date context and require matching participation or linked identity evidence. Treat news/search text as candidate discovery, never numeric statistics or automatic identity certainty.

**Access limitation:** sampled rankings content returned no extracted lines; one tournament URL failed; a match-hub sample displayed “Draw Coming Soon.” These observations mean availability is variable, not that the PDC has no data. Public content accessibility, parser stability and sanctioned access need verification before implementation.

## Proposed recovery ladder (design only)

1. Current exact/provider-ID lookup and approved aliases, unchanged.
2. Inspect cached official event participants and existing historical/profile-link evidence.
3. On a true miss, refresh stale primary directory once, with single-flight protection and bounded deadline.
4. Query only the relevant approved official surface: MODUS results context or PDC profiles/event roster.
5. If still unresolved and permitted, consult a proven event-scoped fallback such as a future DartConnect adapter.
6. Admit a match only with unique corroborated identity; otherwise preserve existing ambiguity/not-found handling. External findings without statistics must not fabricate a DartsOrakel ID, profile or statistical history.

This ladder is a proposal requiring product approval. It does not authorize changes to current return values, user-facing messages, timeouts, source precedence, calculations, command behavior or automated sending.

## Priorities and acceptance evidence

| Priority | Research/design item | Evidence required before rollout |
|---|---|---|
| P0 | Protect country-qualified same-name identities | Lee ENG/WAL collision fixtures; no wrong merge in history, matchup or deduplication |
| P0 | Separate identity miss from directory/source failure | Failure taxonomy and shadow telemetry; no permanent “not found” result from timeout/empty transport |
| P1 | Primary refresh-on-miss and catalogue reuse | Stale-directory/new-entrant replay; one refresh per miss window; preserved cancellation and latency budgets |
| P1 | Reviewed PDC alias/name catalogue | Official source provenance, collision tests, reversible records; no automatic typo poisoning |
| P1 | Reuse existing DartsOrakel result profile IDs | Provider-ID conflict tests; event links validated; identity independent of statistics-directory membership |
| P2 | DartConnect public-source feasibility spike | Current event examples, access review, stable identifiers/schema, measured coverage and latency |
| P2 | Bounded official PDC event fallback | Current draw availability, source-outage fixtures, no accidental past/future event leakage |

Measure baseline and candidate behavior separately on a manually adjudicated MODUS/PDC set: exact names, initials, accents, apostrophes, surname particles, nickname queries, junior/senior distinctions, same-name countries, new entrants, provider typos and unavailable sources. Record correct-resolution rate, wrong-person rate, ambiguous/no-match rate, recovered misses, evidence provenance, fallback calls and P95 latency. Do not claim improved accuracy until benchmarked; wrong-person matches are more harmful than honest unresolved results.

## Deferred / not verified

- WDF or national federation catalogues may be relevant for non-PDC MODUS entrants, but live usable player-index coverage and access were not established in this research. Treat as future discovery, not an evidence-backed ready source.
- No recommendation to add bookmaker pages, social posts, search snippets or LLM guesses as automatic identity authorities.
- No live API load testing, source scraping deployment, credentials, environment files or production requests were used. Web observations are point-in-time and are not service-level guarantees.

## Suggested next approval

Approve an **offline/shadow-only detection benchmark and source feasibility specification**, with explicit no-behavior-change constraints. Then approve small implementations individually based on recovered-miss evidence and zero unacceptable identity regressions, rather than a broad “add more sources” rewrite.
