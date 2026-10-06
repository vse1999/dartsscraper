import type { CoverageDiagnostics } from "./coverage.js";
import type { QualityAssessment } from "./quality.js";

/** Fixed vocabulary and bounded output; no provider text or arbitrary exceptions. */
export function formatResearchDiagnostics(
  assessment: QualityAssessment | undefined,
  coverage: CoverageDiagnostics | undefined,
): readonly string[] {
  const lines: string[] = [];
  if (coverage !== undefined) {
    lines.push(`Observed scope ${coverage.observedRowCount}/${coverage.requestedRowCount ?? "unknown"}; checkout rows: ${coverage.checkout.positiveAttemptRows} positive, ${coverage.checkout.zeroAttemptRows} zero attempts, ${coverage.checkout.missingDenominatorRows} missing; explicit 180/leg pairs ${coverage.explicitLegs.pairedRows}/${coverage.observedRowCount}.`);
  }
  if (assessment !== undefined) {
    if (assessment.validity.status === "rejected") return ["Research evidence rejected; statistics unavailable."];
    lines.push(`Quality: identity ${assessment.dimensions.identity}; observation ${assessment.dimensions.observationAge}; ordering ${assessment.dimensions.ordering}. Provider freshness and format remain unknown unless separately verified.`);
    if (assessment.eligibility.chronologicalTrendComparison.status === "unavailable") {
      const reasons = assessment.eligibility.chronologicalTrendComparison.reasons;
      const reason = reasons.includes("date-tie-crosses-window-boundary") ? "date-only tie crosses the window boundary"
        : reasons.includes("duplicate-composite-id") ? "duplicate match identities"
          : reasons.includes("date-order-inconsistent") ? "inconsistent source order" : "insufficient chronological evidence";
      lines.push(`Disjoint 10-vs-10 trend unavailable: ${reason}; source-order summaries are descriptive only.`);
    }
  }
  return lines;
}
