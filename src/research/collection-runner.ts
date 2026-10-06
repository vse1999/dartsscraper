import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { normalizePlayerName } from "../player/resolver.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { EvidenceIdSchema, type EvidenceSnapshot } from "./evidence.js";
import type { EvidenceLedger } from "./ledger.js";
import type { ResearchHistoryRead } from "./history-service.js";
import { readLocalJson, withLocalLock, writeLocalJson } from "./local-files.js";
import { createCollectionBudget, bindCollectionCancellation, type CollectionBudget } from "./collection-budget.js";
import type { PlayerIdentity } from "../schemas/player.js";
import { assessResearchQuality } from "./quality.js";

export const ResearchBatchInputSchema = z.object({
  version: z.literal(1),
  runLabel: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
  players: z.array(z.string().trim().min(2).max(120)).min(1).max(100),
}).strict();
export type ResearchBatchInput = z.infer<typeof ResearchBatchInputSchema>;
const RowSchema = z.object({
  requestedName: z.string().min(2).max(120),
  status: z.enum(["complete", "failed"]),
  evidenceId: EvidenceIdSchema.nullable(),
  canonicalPlayerId: z.number().int().positive().nullable(),
  failure: z.enum(["SOURCE_UNAVAILABLE", "DEADLINE", "PERSISTENCE_UNAVAILABLE"]).nullable(),
}).strict().superRefine((row, context): void => {
  if ((row.status === "complete") !== (row.evidenceId !== null && row.canonicalPlayerId !== null && row.failure === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Checkpoint row status and evidence are inconsistent." });
  }
});
const CheckpointSchema = z.object({
  version: z.literal(1), id: EvidenceIdSchema,
  checksum: EvidenceIdSchema,
  startedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  players: ResearchBatchInputSchema.shape.players,
  rows: z.array(RowSchema).max(100),
}).strict();
export type ResearchCheckpoint = z.infer<typeof CheckpointSchema>;
function checkpointChecksum(checkpoint: Omit<ResearchCheckpoint, "checksum">): string {
  return createHash("sha256").update(JSON.stringify({ version: checkpoint.version, id: checkpoint.id,
    startedAt: checkpoint.startedAt, updatedAt: checkpoint.updatedAt, players: checkpoint.players,
    rows: checkpoint.rows.map((row) => ({ requestedName: row.requestedName, status: row.status,
      evidenceId: row.evidenceId, canonicalPlayerId: row.canonicalPlayerId, failure: row.failure })) })).digest("hex");
}
function withChecksum(checkpoint: Omit<ResearchCheckpoint, "checksum">): ResearchCheckpoint {
  return CheckpointSchema.parse({ ...checkpoint, checksum: checkpointChecksum(checkpoint) });
}
export interface ResearchCollectionResult {
  readonly checkpoint: ResearchCheckpoint;
  readonly status: "complete" | "partial";
  readonly resumed: number;
  readonly pending: number;
  readonly deliveryAuthorized: false;
}
export interface ResearchCollectionOptions {
  readonly directory: string;
  readonly ledger: EvidenceLedger;
  readonly reader: { getLastMatchesSnapshot(name: string, count: number, signal?: AbortSignal): Promise<ResearchHistoryRead> };
  readonly now?: () => Date;
  readonly budgetMs?: number;
  readonly budget?: CollectionBudget;
  readonly canonicalParticipants?: ReadonlyMap<string, PlayerIdentity>;
}

/** Explicit single-host read-only collection. Completed evidence is resumed, never restamped as current. */
export async function collectResearchBatch(input: unknown, options: ResearchCollectionOptions, signal?: AbortSignal): Promise<ResearchCollectionResult> {
  const parsed = ResearchBatchInputSchema.parse(input);
  const players = [...new Map(parsed.players.map((name: string): readonly [string, string] => [normalizePlayerName(name), name])).values()];
  const now = options.now ?? ((): Date => new Date());
  throwIfAborted(signal);
  const deadline = options.budget === undefined
    ? createCollectionBudget({ ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }), ...(signal === undefined ? {} : { signal }) })
    : bindCollectionCancellation(options.budget, signal);
  const id = createHash("sha256").update(JSON.stringify({ version: 1, runLabel: parsed.runLabel, players })).digest("hex");
  const operation = withLocalLock(options.directory, "collection", async (): Promise<ResearchCollectionResult> => {
    throwIfAborted(deadline.workSignal);
    const file = path.join(options.directory, `${id}.json`);
    const saved = await waitWithSignal(readLocalJson(file), deadline.workSignal);
    throwIfAborted(signal);
    const timestamp = now().toISOString();
    let checkpoint: ResearchCheckpoint = saved === null
      ? withChecksum({ version: 1, id, startedAt: timestamp, updatedAt: timestamp, players, rows: [] })
      : CheckpointSchema.parse(saved);
    if (checkpoint.checksum !== checkpointChecksum(checkpoint) || checkpoint.id !== id || JSON.stringify(checkpoint.players) !== JSON.stringify(players)
      || Date.parse(checkpoint.updatedAt) > now().getTime() || checkpoint.startedAt > checkpoint.updatedAt
      || new Set(checkpoint.rows.map((row) => normalizePlayerName(row.requestedName))).size !== checkpoint.rows.length
      || checkpoint.rows.some((row) => !players.includes(row.requestedName))) {
      throw new Error("Research checkpoint identity, timestamps or player inventory do not match this batch.");
    }
    let resumed = 0;
    for (const row of checkpoint.rows) {
      throwIfAborted(signal);
      if (row.status !== "complete" || row.evidenceId === null) continue;
      const record = await waitWithSignal(options.ledger.read(row.evidenceId), deadline.workSignal);
      if (record === null || record.player.id !== row.canonicalPlayerId) throw new Error("Checkpoint evidence is missing or has a different identity; restore the ledger before resuming.");
      const expected = options.canonicalParticipants?.get(row.requestedName);
      if (options.canonicalParticipants !== undefined && (expected === undefined || expected.id !== record.player.id
        || expected.name !== record.player.name || expected.slug !== record.player.slug)) {
        throw new Error("Checkpoint evidence differs from the verified fixture participant; restore verified associations before resuming.");
      }
      resumed += 1;
    }
    for (const name of players) {
      throwIfAborted(signal);
      if (deadline.workSignal.aborted || deadline.workRemainingMs() <= 0) break;
      if (checkpoint.rows.some((row) => row.requestedName === name && row.status === "complete")) continue;
      let row: z.infer<typeof RowSchema>;
      try {
        const result = await waitWithSignal(options.reader.getLastMatchesSnapshot(name, 20, deadline.workSignal), deadline.workSignal);
        throwIfAborted(deadline.workSignal);
        const expected = options.canonicalParticipants?.get(name);
        if (options.canonicalParticipants !== undefined && (expected === undefined || expected.id !== result.value.player.id
          || expected.name !== result.value.player.name || expected.slug !== result.value.player.slug)) throw new Error("Collected identity differs from the verified fixture participant.");
        let record: EvidenceSnapshot | null = null;
        if (result.evidence.persistence === "local") {
          try {
            record = await waitWithSignal(options.ledger.read(result.evidence.id), deadline.workSignal);
          } catch (error: unknown) {
            throwIfAborted(signal);
            if (deadline.workSignal.aborted) throw error;
            // A failed receipt read is a storage failure, not a failure from the data source.
          }
        }
        // Existence alone cannot bind a receipt to the identity and rows being checkpointed.
        const verified = record !== null && record.id === result.evidence.id && record.requestedCount >= 20
          && record.player.name === result.value.player.name && record.player.slug === result.value.player.slug
          && assessResearchQuality(result.value.matches, { evidence: record, expectedPlayerId: result.value.player.id, now: now() }).validity.status === "valid";
        if (!verified) {
          row = { requestedName: name, status: "failed", evidenceId: null, canonicalPlayerId: null, failure: "PERSISTENCE_UNAVAILABLE" };
        } else row = { requestedName: name, status: "complete", evidenceId: result.evidence.id, canonicalPlayerId: result.value.player.id, failure: null };
      } catch (error: unknown) {
        throwIfAborted(signal);
        void error;
        row = { requestedName: name, status: "failed", evidenceId: null, canonicalPlayerId: null, failure: deadline.workSignal.aborted ? "DEADLINE" : "SOURCE_UNAVAILABLE" };
      }
      throwIfAborted(deadline.totalSignal);
      checkpoint = withChecksum({ ...checkpoint, updatedAt: now().toISOString(), rows: [...checkpoint.rows.filter((existing) => existing.requestedName !== name), row] });
      await writeLocalJson(file, checkpoint);
    }
    const pending = players.length - checkpoint.rows.filter((row) => row.status === "complete").length;
    return { checkpoint, status: pending === 0 ? "complete" : "partial", resumed, pending, deliveryAuthorized: false };
  });
  try { return await waitWithSignal(operation, deadline.totalSignal); }
  finally { if (options.budget === undefined) deadline.close(); }
}
