import { createHash } from "node:crypto";
import { z } from "zod";
import { MatchResultSchema, MatchSchema, type MatchResult } from "../schemas/match.js";

export const MAX_EVIDENCE_MATCHES = 1000;
export const EvidenceIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  "Expected a real calendar date.",
);
export const EvidenceSnapshotSchema = z.object({
  id: EvidenceIdSchema,
  version: z.literal(1),
  player: MatchResultSchema.shape.player,
  matches: z.array(MatchSchema).max(MAX_EVIDENCE_MATCHES),
  observedAt: z.string().datetime(),
  sourceUpdatedAt: z.null(),
  dateTo: CalendarDateSchema,
  requestedCount: z.number().int().positive().max(MAX_EVIDENCE_MATCHES),
  acquiredCount: z.number().int().nonnegative().max(MAX_EVIDENCE_MATCHES),
  source: z.object({
    provider: z.literal("dartsorakel"),
    url: z.string().url(),
    parserVersion: z.literal("1"),
    queryCompleteness: z.literal("unknown"),
  }).strict(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.acquiredCount !== snapshot.matches.length || snapshot.acquiredCount > snapshot.requestedCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence counts do not match the acquired query scope." });
  }
  if (snapshot.source.url !== `https://dartsorakel.com/player/details/${snapshot.player.id}/${encodeURIComponent(snapshot.player.slug)}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence source does not match canonical player." });
  }
  for (const match of snapshot.matches) {
    if (match.date > snapshot.dateTo || !CalendarDateSchema.safeParse(match.date).success) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Match date is invalid or exceeds query cutoff." });
    }
    if (match.provenance?.opponentId === snapshot.player.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence identifies the player as their own opponent." });
    }
    if (match.provenance !== undefined && match.provenance.sourceUrl !== snapshot.source.url) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Match provenance source does not match the snapshot player." });
    }
    if (!["won", "win", "w", "lost", "loss", "l", "draw", "drawn", "d"].includes(match.result.trim().toLowerCase())) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence may only contain explicitly completed match results." });
    }
  }
});
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;

/** Canonical ordering makes hashes stable across JSON key order, not match order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Evidence contains an unsupported JSON value.");
  return encoded;
}

function evidenceId(snapshot: Omit<EvidenceSnapshot, "id">): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function createEvidenceSnapshot(result: MatchResult, observedAt: string, dateTo: string, requestedCount: number): EvidenceSnapshot {
  const parsed = MatchResultSchema.parse(result);
  const body: Omit<EvidenceSnapshot, "id"> = {
    version: 1, player: parsed.player, matches: parsed.matches,
    observedAt, sourceUpdatedAt: null, dateTo, requestedCount, acquiredCount: parsed.matches.length,
    source: { provider: "dartsorakel", url: `https://dartsorakel.com/player/details/${parsed.player.id}/${encodeURIComponent(parsed.player.slug)}`, parserVersion: "1", queryCompleteness: "unknown" },
  };
  return EvidenceSnapshotSchema.parse({ id: evidenceId(body), ...body });
}

export function validateEvidenceSnapshot(value: unknown, now: Date = new Date()): EvidenceSnapshot {
  const snapshot = EvidenceSnapshotSchema.parse(value);
  const { id, ...body } = snapshot;
  if (id !== evidenceId(body)) throw new Error("Evidence integrity check failed: content hash does not match ID.");
  if (!Number.isFinite(now.getTime()) || Date.parse(snapshot.observedAt) > now.getTime()) {
    throw new Error("Evidence observation time is in the future; check the collector clock.");
  }
  // Existing provider queries use tomorrow's Budapest date as the upper bound.
  // A query boundary is not a completed-result timestamp.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(snapshot.observedAt));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
  const localDate = `${part("year")}-${part("month")}-${part("day")}`;
  const nextDate = new Date(`${localDate}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  if (snapshot.dateTo > nextDate.toISOString().slice(0, 10) || snapshot.matches.some((match) => match.date > localDate)) {
    throw new Error("Evidence has a future completed result or unsupported query cutoff.");
  }
  return snapshot;
}
