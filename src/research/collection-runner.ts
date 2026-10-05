import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { normalizePlayerName } from "../player/resolver.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { EvidenceIdSchema } from "./evidence.js";
import type { EvidenceLedger } from "./ledger.js";
import type { ResearchHistoryRead } from "./history-service.js";
import { readLocalJson, withLocalLock, writeLocalJson } from "./local-files.js";

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
}

/** Explicit single-host read-only collection. Completed evidence is resumed, never restamped as current. */
export async function collectResearchBatch(input: unknown, options: ResearchCollectionOptions, signal?: AbortSignal): Promise<ResearchCollectionResult> {
  const parsed = ResearchBatchInputSchema.parse(input);
  const players = [...new Map(parsed.players.map((name: string): readonly [string, string] => [normalizePlayerName(name), name])).values()];
  const now = options.now ?? ((): Date => new Date());
  const budget = options.budgetMs ?? 220_000;
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 300_000) throw new Error("Research collection budget must be between 1 and 300000 milliseconds.");
  throwIfAborted(signal);
  const id = createHash("sha256").update(JSON.stringify({ version: 1, runLabel: parsed.runLabel, players })).digest("hex");
  return withLocalLock(options.directory, "collection", async (): Promise<ResearchCollectionResult> => {
    const file = path.join(options.directory, `${id}.json`);
    const saved = await readLocalJson(file);
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
      const record = await options.ledger.read(row.evidenceId);
      if (record === null || record.player.id !== row.canonicalPlayerId) throw new Error("Checkpoint evidence is missing or has a different identity; restore the ledger before resuming.");
      resumed += 1;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    const timer = setTimeout((): void => controller.abort(new Error("Research collection deadline reached.")), budget);
    try {
      for (const name of players) {
        if (controller.signal.aborted) break;
        if (checkpoint.rows.some((row) => row.requestedName === name && row.status === "complete")) continue;
        let row: z.infer<typeof RowSchema>;
        try {
          const result = await waitWithSignal(options.reader.getLastMatchesSnapshot(name, 20, controller.signal), controller.signal);
          throwIfAborted(controller.signal);
          if (result.evidence.persistence !== "local" || await options.ledger.read(result.evidence.id) === null) {
            row = { requestedName: name, status: "failed", evidenceId: null, canonicalPlayerId: null, failure: "PERSISTENCE_UNAVAILABLE" };
          } else row = { requestedName: name, status: "complete", evidenceId: result.evidence.id, canonicalPlayerId: result.value.player.id, failure: null };
        } catch (error: unknown) {
          void error;
          row = { requestedName: name, status: "failed", evidenceId: null, canonicalPlayerId: null, failure: controller.signal.aborted ? "DEADLINE" : "SOURCE_UNAVAILABLE" };
        }
        checkpoint = withChecksum({ ...checkpoint, updatedAt: now().toISOString(), rows: [...checkpoint.rows.filter((existing) => existing.requestedName !== name), row] });
        await writeLocalJson(file, checkpoint);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    const pending = players.length - checkpoint.rows.filter((row) => row.status === "complete").length;
    return { checkpoint, status: pending === 0 ? "complete" : "partial", resumed, pending, deliveryAuthorized: false };
  });
}
