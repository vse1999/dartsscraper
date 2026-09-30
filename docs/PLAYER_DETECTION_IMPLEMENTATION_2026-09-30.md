# Player-detection strengthening: implementation and verification

## Scope and acceptance

Implemented a reliability-focused slice of the product review, orchestrated with GPT-6 Luna subagents at xhigh. Review baseline: `3c87c7a09b46081048bcd95a756ad6d9f88f32e2` (approved by the user).

Commands, report contracts, statistics calculations and provider routing remain unchanged. Detection intentionally changes in two ways: evidence-backed misses can recover, while contradictory identities/fixture occurrences now abstain instead of being guessed. No cross-provider substitution, new player metrics, dependencies, deployment or Telegram sends were introduced.

## Changes

- **Directory freshness:** five-minute in-memory TTL and one coalesced refresh on a genuine miss, with a 30-second cooldown. Expired/miss refreshes bypass the DartsOrakel client's longer raw-response cache. Per-caller cancellation does not poison shared refresh work.
- **Identity safety:** deduplicate identical IDs; quarantine conflicting identities; normalize fuzzy comparison by the actual representation compared. Ambiguity does not trigger repeated refreshes. Completed match rows must identify the requested player as exactly one participant.
- **Value reports:** verified source-profile evidence can trigger one directory refresh when a full-name participant is genuinely absent; refresh failure does not discard already verified participants.
- **MODUS identity:** preserve country qualifiers and distinguish homonyms such as Lee (ENG) Evans and Lee (WAL) Evans. Retain unresolved fixture labels rather than throwing away the whole valid fixture source.
- **MODUS secondary evidence:** on unresolved fixture/roster pairs, consult the current official results page, then verify match detail ID, official URL, date, pair, series, week and group. This never manufactures DartsOrakel IDs or transfers official averages into another provider's metrics. Both runtime factories supply bundled identity names for collision checking.
- **MODUS history:** caller cancellation, coalesced catalogue discovery, five-minute match-detail caching and country-aware identity verification. The existing official-history route remains official.
- **PDC:** identify live PDC event context, reconcile unique exact pairs before replacements, abstain on ties, and require matching explicit event/round evidence for opponent replacements. Exact pairs reject conflicting explicit rounds. PDPA diagnostics distinguish unpublished draws, no candidate, empty dated draws and partial/all-page failures without changing public result schemas.
- **Diagnostics:** privacy-safe player research outcomes identify misses, ambiguity, incomplete history, timeout/rate-limit/provider failures and returned evidence coverage. They omit player names, queries, credentials and raw error text.
- **Smoke tooling:** the MODUS smoke script now explicitly requests MODUS rather than auto-routing and then expecting official MODUS output.

## Bounds and deliberate tradeoffs

MODUS recovery reads only the selected official week/group, caches that page for 15 seconds, and permits at most four distinct detail requests per page snapshot. It is not an exhaustive cross-group crawler. Bundled identity names help detect known collisions but do not prove live catalogue completeness.

An unqualified fallback label is not promoted to a country-qualified identity, even if only one qualified candidate is currently known. This deliberately favors precision over recall: unknown country variants may exist outside the selected page/bundle. Explicit qualifiers require agreeing detail evidence. The existing directory resolver can still resolve independently verified unique names.

PDC ordinal/last-N round equivalence is mapped only for the supported known 32-player main-draw event contexts; other events are not assumed to have that field size. Missing round evidence can enrich a unique exact pair, but cannot justify changing an opponent.

No PDC.tv/DartConnect adapter was added: a stable, verified public draw/identity contract was not established during research. First-nonempty-source completeness, broader current-group coverage, optional enrichment resilience and quota/date-policy proposals remain follow-up work, not claimed completed features.

## Verification (2026-09-30)

- `npm run build`: passed after final implementation.
- `npm test`: **65 files, 630 tests passed**, with no unhandled rejection in the final run. Baseline was 62 files / 577 tests. An earlier cancellation-test rejection-handler timing issue was corrected before this final run.
- `npm run audit:prod`: **0 reported vulnerabilities**.
- `git diff --check`: passed; only Windows LF/CRLF conversion warnings.
- Public read-only official MODUS stats smoke: Robert Thornton, three requested/returned matches and three available averages; latest September 30 match versus Nico Plovier.
- Public read-only DartsOrakel CLI smoke: Damon Heta, identity 13, three completed matches with expected metric coverage.
- Public read-only fallback smoke: official match `20322`, September 30; `Wiles M.` / `Widmayer J.` recovered as Michael Wiles / Jim Widmayer after detail verification. An initial smoke used unsupported initial-first abbreviations (`M. Wiles`); it correctly abstained. The corrected provider-format smoke passed.

These public checks are point-in-time observations, not guarantees about every player, future upstream markup or production delivery. No Telegram message was sent and no production deployment was tested.

## Independent review

**Standards:** no hard violations found; changed TypeScript uses explicit types and no `any`, cancellation/refresh bounds are tested, and no secret exposure was found. Nonblocking maintainability note: the MODUS history service combines discovery, caching and conversion in a 513-line module; consider extracting cohesive helpers in a separate maintenance task.

**Spec:** the reviewer identified missing round evidence checks for PDC exact pairs and cross-group MODUS collision awareness. Both were corrected and regression-tested. Final re-review found no remaining high-risk correctness issue; selected-group coverage and strict unqualified-to-qualified abstention remain the documented recall tradeoffs above.

Reviewers were read-only; their sandbox-only test attempt was blocked by process-spawn permissions, not counted as a pass. The orchestrator ran the final complete suite with approved subprocess access.

## Related analysis

- `BOT_PLAYER_DETECTION_PRODUCT_REVIEW_2026-09-30.md`: original product audit and prioritized roadmap.
- `player-detection-source-research-2026-09-30.md`: primary-source research and adapter constraints.

Changes remain local and uncommitted; nothing was pushed, published or deployed.
