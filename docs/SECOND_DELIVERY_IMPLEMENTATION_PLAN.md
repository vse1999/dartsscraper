# Second delivery implementation plan

Date: 2026-10-05. Design only: #4 context, #5 point-in-time evaluation, #7 odds history. Implement only after first-delivery gates; no live monitoring activation, probability model or paid acquisition implied.

## Simplest defensible architecture

Extend the same research layer with typed context observations, odds observations and an offline evaluator. Reuse current PDPA/PDC, official MODUS, DartsOrakel and Eredmenyek adapters. No microservices, streaming framework or LLM arithmetic. Existing source separation and schemas reduce risk; no evidence requires distributed services.

Source adapters own observations, the ledger owns versions/as-of availability, pure functions own joins/features/evaluation, and current formatters own output. Hosted durability/global quota reservations require an approved transactional store adapter; do not substitute process memory or Vercel local files.

## Step-by-step

1. **Agree pilot and data rights.** Select one competition/session, bookmaker and read-only market. Verify permitted collection/retention/internal use and exact coverage. No CAPTCHA/auth/geoblock workaround, proxy rotation, bookmaker login, publication or spending. If permitted free data cannot satisfy the contract, stop live acquisition and retain offline evaluation.
2. **Context contracts.** Define verified format: standard/double-in, sets/legs, length, stage/floor, round, session and optional throw order. Each field carries source observation and scope. Unknown is explicit. Map by canonical event occurrence, not tournament-name guesses. Validate replacements/rematches and context corrections.
3. **Context adapter pilot.** Capture official samples and implement only supported fields. Add golden fixtures for ordinary events, double-in, set-based scores, schedule changes and unsupported formats. Grand Prix double-start is documented by PDC; this supports distinguishing formats, not an invented numerical correction.
4. **Opponent-adjusted baseline.** Preserve opponent IDs and chronological results. Implement a simple deterministic Elo baseline with versioned parameters. Start with descriptive format splits and minimum-sample warnings; shrink sparse samples only under documented/tested policy. Report complete H2H search scope. No model coefficients from anecdotes.
5. **Odds ledger.** Archive exact paired observations with bookmaker/source/event/market/selection IDs, price, observation time, source-update time when supplied, status and scheduled start. Keep snapshots immutable; "opening/closing" requires actual sampled observations and explicit capture gaps. Never combine sides from different bookmakers/times/markets.
6. **Transparent market metrics.** For validated two-outcome decimal odds, calculate overround and proportional-margin baseline. Label it as a normalization assumption, not truth. Reject unsupported draw/settlement rules, suspended/stale/promotional markets and unknown selected-player mappings. Market movement does not prove sharp money.
7. **As-of dataset.** Join only records observed at or before decision time and completed before the cutoff. Separate event-time and availability-time. Same-day date-only ambiguity is quarantined. Later corrections and retrospectively available rows cannot contaminate earlier feature sets. Include missing/skipped/source-failed rows with reasons.
8. **Walk-forward evaluator.** Use calendar periods with tournament/session grouping, earlier training/validation and untouched later test data. Darts observations are irregular, so do not blindly use equal-row folds. Compare existing form heuristics, Elo and aligned market baselines; then evaluate incremental context/metric feature groups. Fit any calibration only on independent earlier data.
9. **Metrics and uncertainty.** Report Brier/log loss, calibration diagrams with bin counts, subgroup coverage, abstention and uncertainty. Accuracy alone and Brier alone are insufficient. Record manual usefulness/time savings separately from prediction metrics. No automatic wagering/staking or profitability claim.
10. **Shadow/operational gate.** Run one approved shadow pilot. Review the first 20 candidate briefs for usability; that sample is not sufficient proof of calibration. Verify full source inventory, cold/warm load, quota and deadline handling, restart state and correction replay. Enable no proactive delivery without separate owner approval.

## Logical decision proofs and alternatives

- **Context before adjustment:** event rules can change score interpretation; official metadata prevents false leg denominators. Inferring from score text is simpler but unsafe for set matches.
- **Elo before complex models:** results and opponent identities already exist; a transparent baseline establishes whether added complexity buys anything. Reject complexity without held-out benefit.
- **Immutable odds before historical-feed procurement:** archive existing permitted observations first. Paid feeds may have no required darts/bookmaker coverage; buy nothing until sample contracts and rights prove value.
- **Availability-time before retrospective backtests:** a fact learned after a match was unavailable for that decision. Filtering only by played date leaks information.
- **Chronological evaluation before probabilities:** random splits can train on future evidence. Proper scores plus calibration expose overconfidence; model choice belongs after measurement.
- **Single-host pilot before hosted runner:** local checkpointing establishes behavior cheaply. Cross-instance leases/outbox/quota claims need real transactional persistence; implement those only on the approved backend.

## Acceptance and stop conditions

- Proven context/odds identity; no accidental cross-event, cross-bookmaker or reversed-selection join.
- Golden tests for double-in/sets, withdrawals, corrections, stale/suspended prices and observation/completion ambiguity.
- Future-information canaries must fail evaluation; replay produces identical outputs with no network.
- Evaluation includes missing records and subgroup sizes. Features retained only for supported held-out improvement or measured manual usefulness.
- No prediction release until sufficient evidence/calibration; no alerts until freshness/status/permission/operational gates pass.
- No "all data", "exactly once", "free forever" or "proven edge" promises.

## Primary evidence

- [PDC double-start example](https://www.pdc.tv/news/2025/10/11/2025-boyle-sports-world-grand-prix-semi-finals-latest).
- [Calibration and proper-score limitations](https://scikit-learn.org/stable/modules/calibration.html).
- [Time-series splitting assumptions](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).
- [Historical feed snapshot/coverage constraints](https://the-odds-api.com/historical-odds-data/): not evidence of required darts/TippmixPro coverage.

These are proposed gates, not certifications of production readiness or legal permission. Recheck current provider contracts before implementation.
