import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { EvidenceIdSchema } from "./evidence.js";
import type { EvidenceLedger } from "./ledger.js";
import { readLocalJson, withLocalLock, writeLocalJson } from "./local-files.js";

export const ResearchFeedbackInputSchema = z.object({
  evidenceId: EvidenceIdSchema,
  label: z.enum(["useful", "not-useful", "incorrect"]),
  reason: z.enum(["time-saved", "source-error", "identity-error", "missing-data", "unclear", "other"]),
}).strict();
const FeedbackRecordSchema = ResearchFeedbackInputSchema.extend({ version: z.literal(1), id: EvidenceIdSchema, recordedAt: z.string().datetime() }).strict();
const FeedbackHistorySchema = z.array(FeedbackRecordSchema).max(1_000);
export type ResearchFeedback = z.infer<typeof FeedbackRecordSchema>;
function feedbackId(record: Omit<ResearchFeedback, "id">): string {
  return createHash("sha256").update(JSON.stringify({ evidenceId: record.evidenceId, label: record.label,
    reason: record.reason, version: record.version, recordedAt: record.recordedAt })).digest("hex");
}

/** Local owner workflow only. Enumerated reasons intentionally exclude arbitrary secret-bearing notes. */
export async function recordResearchFeedback(input: unknown, ledger: EvidenceLedger, directory: string, now: () => Date = (): Date => new Date()): Promise<ResearchFeedback> {
  const parsed = ResearchFeedbackInputSchema.parse(input);
  if (await ledger.read(parsed.evidenceId) === null) throw new Error("Feedback evidence does not exist in this ledger; replay a valid evidence ID first.");
  return withLocalLock(directory, "feedback", async (): Promise<ResearchFeedback> => {
    const file = path.join(directory, "feedback.json");
    const saved = await readLocalJson(file);
    const previous = saved === null ? [] : FeedbackHistorySchema.parse(saved);
    if (previous.some((record) => feedbackId(record) !== record.id || Date.parse(record.recordedAt) > now().getTime())) {
      throw new Error("Feedback integrity/timestamp check failed; restore verified records before adding feedback.");
    }
    if (previous.length >= 1_000) throw new Error("Feedback capacity reached; archive feedback explicitly before adding more.");
    const body = { ...parsed, version: 1 as const, recordedAt: now().toISOString() };
    const record = FeedbackRecordSchema.parse({ ...body, id: feedbackId(body) });
    await writeLocalJson(file, [...previous, record]);
    return record;
  });
}
