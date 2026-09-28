# Offline watchlist core

## Authorization and purpose

The owner approved this narrower implementation after the live-source feasibility gate failed, then requested further implementation and public-page investigation. This work provides deterministic validation, descriptive screening, batching, deduplication, local replay, research-only HTML previews, advisory quota evaluation, and a rendered OddsPortal table parser. It does **not** implement unattended live odds monitoring.

The watchlist modules are intentionally not imported by existing API routes, Telegram commands, schedulers or deployment configuration. There are no new dependencies, database migrations, bookmaker requests or Telegram sends in the implementation. A separate ordinary browser inspection verified the rendered table structure; it did not activate a collector.

## Boundaries

- Caller supplies normalized canonical identities, provenance, timestamps, explicit versioned rules and an injected clock. Schemas validate structure and consistency; they cannot prove that a source actually published a quote or that collection was permitted.
- Synthetic fixtures use `example.test` URLs. Bookmaker/source labels are illustrative identifiers, not verified coverage or approved live samples. Their thresholds are test inputs, not calibrated recommendations.
- Screening produces research eligibility and descriptive reasons/coverage. It never estimates a win probability, positive expected value or betting profitability. Agreement between overlapping last-10/20 windows is not independent confirmation.
- Missing or contradictory required information fails closed. Historical ordering requires stable match identities and completion timestamps not guaranteed by the existing scraper; no adapter invents these fields.
- Batch state is a pure sequential replay model. JSON round-tripping demonstrates preservation of state, not durable storage, concurrency safety or exactly-once delivery. Production requires the separate persistence/access gates in the full plan.
- Delivery transitions are simulations. A sending/uncertain outcome must not be blindly retried. A sent outcome only reflects a test caller's simulated acknowledgement, never a real Telegram confirmation.
- Replay `researchPreviews` are owner/candidate-scoped HTML evidence labelled `research-only` with delivery authorization explicitly false. A supplied quota decision is advisory: even `allowed` output is only a proposal and never commits a reservation, collects data, or sends a message.

## Behavior under test

1. Validate quote, bookmaker/source identity, participant mapping, prematch/open status, freshness, start safety margin and contextual evidence.
2. Derive last 10 from the same ordered history used for last 20; expose sample sizes and metric denominators.
3. Apply explicit descriptive thresholds to the selected player against the opponent: full required thresholds apply to last-10, while a complete last-20 window checks required metric direction only. Weighted checkout uses hits/attempts; 180 rate uses total 180s divided by corresponding total legs.
4. Use canonical matchup identity independent of bookmaker, selected-player column order, rule version and round labels; event occurrence, authoritative event ID and the unordered player pair distinguish rematches/replacements.
5. Collect opening-round candidates in fixed 120-second windows and later-round candidates in 60-second windows. New arrivals cannot extend an open deadline.
6. Group by owner/competition/round, require revalidation before simulated delivery, paginate without a hidden hourly cap, preserve sent/uncertain deduplication through snapshot reload.
7. Continue local screening and research preview formatting when the optional quota policy reports `paused`; quota state is reported separately from analytical eligibility.

## Verification

### Rendered-page boundary

`parseOddsPortalRenderedTable` accepts captured HTML, an OddsPortal darts source URL and an observation timestamp. It reads only exact two-outcome table structures and paired prices attributed to the same bookmaker. It never requests bookmaker, bonus or betslip links. It reports shell-only responses, ambiguous tables, malformed rows, conflicting bookmaker identities, disabled prices and duplicates explicitly.

The output is raw aggregator evidence, **not** a `WatchlistScreenInput`. Price update time, player/selection mapping, start/status and market identity are not invented. Even a structurally clean table is not permission to send an alert. The initial inspected event was MODUS; PDC coverage and Tippmixpro availability remain unverified.

### Local replay

The explicit local command is `npx tsx scripts/watchlist-replay.ts --input PATH_TO_SCENARIO_JSON`. It evaluates a bounded JSON scenario using its injected timestamp, returns research-only HTML previews, an advisory `quotaDecision` when quota input is supplied, proposed pages and serialized state to stdout, and does not send anything. A later scenario may supply that state plus refreshed revalidation evidence. A restart snapshot with an ambiguous in-progress send must use conservative recovery, never an automatic resend. The reusable synthetic smoke fixture is `tests/fixtures/watchlist-v2-replay.json`.

Replay limits are 1,000,000 input bytes, 100 candidates/revalidations, and a page size of at most 50. The fixture uses `example.test` evidence only; it does not verify production URLs, bookmaker coverage or allowlists. Quota evaluation is pure local advisory processing and has no reservation, HTTP, database or transport side effect.

The executable tests demonstrate valid scenarios; no live-source defaults or credentials are supplied. Caller-provided normalized inputs remain assertions requiring verified adapters before any production use.

Replay limitations: state tracks matchup envelopes, not immutable selected-player/quote evidence. Revalidation is descriptive matchup research, not authorization to send a selection. The live pipeline must persist the exact selected player, quote and research snapshot and bind pre-send validation to that evidence. Suppressed/expired entries are conservative tombstones in this replay model; live reconsideration semantics require a separate explicit design before activation. Date-only history has no fabricated completion timestamp: the future adapter must provide an exhaustive/order proof (or quarantine a last-20 cutoff that cannot be proven from the current maximum of 20 rows).

Run `npm run build` and `npm test -- --maxWorkers=2 --minWorkers=1` from the repository. The worker limit keeps verification resource usage bounded; it is not a production configuration change. On the current Windows sandbox, Vitest worker creation required approved execution outside the sandbox because ordinary execution returned `spawn EPERM`.

See the watchlist tests for executable synthetic examples. Test success establishes the exercised offline behavior only, not source access, bookmaker coverage, real-time latency, cloud quota capacity, or profitability.

Historical verification on 2026-09-25 covered the earlier offline core. Current v2 replay verification must be reported from the current run; no historical count is evidence for the current preview/quota fields. No commits, pushes, deployment or live alerts were performed.

## Still excluded

Live OddsPortal/Tippmixpro transport adapters, account access, production storage, distributed leases, automatic polling, customer publication, actual alerts, deployment, and source-permission workarounds. Resume live activation only after the gates in `ODDS_WATCHLIST_FEASIBILITY.md` pass and the applicable operational actions are approved.
