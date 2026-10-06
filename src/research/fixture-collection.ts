import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IsoDateSchema } from "../agent/date.js";
import type { PlayerIdentity } from "../schemas/player.js";
import { normalizePlayerName } from "../player/resolver.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { createCollectionBudget, bindCollectionCancellation, type CollectionBudget } from "./collection-budget.js";
import { buildCollectionPlan, type CollectionPlan } from "./collection-plan.js";
import { collectResearchBatch, type ResearchCollectionResult } from "./collection-runner.js";
import { EvidenceIdSchema } from "./evidence.js";
import { resolveFixtureInventory, type FixtureInventoryDraft, type FixtureParticipantResolver, type FixtureResearchInventory } from "./fixture-inventory.js";
import type { ResearchHistoryRead } from "./history-service.js";
import type { EvidenceLedger } from "./ledger.js";
import { readLocalJson, withLocalLock, writeLocalJson } from "./local-files.js";

const InputSchema = z.object({ source: z.enum(["pdc", "modus"]), date: IsoDateSchema,
  runLabel: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u) }).strict();
const ManifestSchema = z.object({ version: z.literal(2), runId: EvidenceIdSchema, inventoryId: EvidenceIdSchema,
  associationsId: EvidenceIdSchema, requestedCount: z.literal(20), source: InputSchema.shape.source,
  date: IsoDateSchema, runLabel: InputSchema.shape.runLabel, createdAt: z.string().datetime(),
  executionIds: z.array(z.number().int().positive()).max(100), checksum: EvidenceIdSchema }).strict();
type Manifest = z.infer<typeof ManifestSchema>;

export interface FixtureCollectionReader {
  getResolvedMatchesSnapshot(player: PlayerIdentity, count: number, signal?: AbortSignal): Promise<ResearchHistoryRead>;
  peekFreshSnapshot(player: PlayerIdentity, count: number): ResearchHistoryRead | null;
}
export interface FixtureCollectionOptions {
  readonly directory: string;
  readonly ledger: EvidenceLedger;
  readonly reader: FixtureCollectionReader;
  readonly resolveParticipant: FixtureParticipantResolver;
  readonly discover: (signal: AbortSignal) => Promise<FixtureInventoryDraft>;
  readonly budgetMs?: number;
  readonly budget?: CollectionBudget;
  readonly now?: () => Date;
}
export interface FixtureParticipantOutcome {
  readonly playerId: number;
  readonly status: "complete" | "failed" | "deferred-deadline";
  readonly evidenceId: string | null;
  readonly failure: "SOURCE_UNAVAILABLE" | "DEADLINE" | "PERSISTENCE_UNAVAILABLE" | null;
}
export interface FixtureCollectionResult {
  readonly version: 2;
  readonly inventory: FixtureResearchInventory;
  readonly plan: CollectionPlan;
  readonly outcomes: readonly FixtureParticipantOutcome[];
  readonly collection: ResearchCollectionResult | null;
  readonly status: "complete" | "partial";
  readonly referenceCounts: { readonly total: number; readonly complete: number; readonly failed: number; readonly deferred: number; readonly unresolved: number; readonly excluded: number };
  readonly deliveryAuthorized: false;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function manifestChecksum(value: Omit<Manifest, "checksum">): string {
  return digest({ version: value.version, runId: value.runId, inventoryId: value.inventoryId,
    associationsId: value.associationsId, requestedCount: value.requestedCount, source: value.source,
    date: value.date, runLabel: value.runLabel, createdAt: value.createdAt, executionIds: value.executionIds });
}

/** Explicit read-only local collection; version-2 manifest owns associations, v1 job receipts remain compatible. */
export async function collectFixtureResearch(input: unknown, options: FixtureCollectionOptions, signal?: AbortSignal): Promise<FixtureCollectionResult> {
  const parsed = InputSchema.parse(input);
  throwIfAborted(signal);
  const budget = options.budget === undefined
    ? createCollectionBudget({ ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }), ...(signal === undefined ? {} : { signal }) })
    : bindCollectionCancellation(options.budget, signal);
  const now = options.now ?? ((): Date => new Date());
  const operation = withLocalLock(options.directory, "collection", async (): Promise<FixtureCollectionResult> => {
    throwIfAborted(budget.workSignal);
    const draft = await waitWithSignal(options.discover(budget.workSignal), budget.workSignal);
    if (draft.source !== parsed.source || draft.date !== parsed.date) throw new Error("Fixture discovery returned a different source or date.");
    const inventory = await resolveFixtureInventory(draft, options.resolveParticipant, budget.workSignal);
    throwIfAborted(signal);
    // The compatible v1 runner keys jobs by normalized name, not canonical ID.
    // Reject ambiguous associations before publishing state instead of silently dropping a player.
    if (new Set(inventory.participants.map((participant): string => normalizePlayerName(participant.player.name))).size !== inventory.participants.length) {
      throw new Error("Canonical fixture participants have conflicting normalized names; verify identities before collection.");
    }
    const plan = buildCollectionPlan(inventory.participants, (player: PlayerIdentity, count: number): boolean => options.reader.peekFreshSnapshot(player, count) !== null);
    if (budget.workSignal.aborted || budget.workRemainingMs() <= 0) {
      // A partially resolved inventory cannot replace a previously verified identity manifest.
      // Leave durable state untouched so a later explicit retry can finish resolution safely.
      const counts = { total: inventory.references.length, complete: 0, failed: 0,
        deferred: inventory.references.filter((reference): boolean => reference.status === "resolved").length,
        unresolved: inventory.references.filter((reference): boolean => reference.status === "unresolved").length,
        excluded: inventory.references.filter((reference): boolean => reference.status === "excluded-limit").length };
      throwIfAborted(budget.totalSignal);
      return { version: 2, inventory, plan,
        outcomes: inventory.participants.map((participant): FixtureParticipantOutcome => ({ playerId: participant.player.id,
          status: "deferred-deadline", evidenceId: null, failure: "DEADLINE" })),
        collection: null, status: counts.total === 0 ? "complete" : "partial", referenceCounts: counts, deliveryAuthorized: false };
    }
    const runId = digest(parsed);
    const associationsId = digest({ participants: inventory.participants, references: inventory.references });
    const manifestDirectory = path.join(options.directory, "fixture-v2");
    // The nested v1 runner creates jobs directories; this manifest namespace is owned by the same outer lock.
    await mkdir(manifestDirectory, { recursive: true });
    throwIfAborted(budget.totalSignal);
    const file = path.join(manifestDirectory, `${runId}.json`);
    const saved = await waitWithSignal(readLocalJson(file), budget.totalSignal);
    const body = { version: 2 as const, runId, inventoryId: inventory.id, associationsId, requestedCount: 20 as const,
      ...parsed, createdAt: now().toISOString(), executionIds: plan.items.map((item): number => item.player.id) };
    const manifest = saved === null ? ManifestSchema.parse({ ...body, checksum: manifestChecksum(body) }) : ManifestSchema.parse(saved);
    if (manifest.checksum !== manifestChecksum(manifest) || manifest.runId !== runId || manifest.inventoryId !== inventory.id
      || manifest.associationsId !== associationsId || manifest.source !== parsed.source || manifest.date !== parsed.date
      || manifest.runLabel !== parsed.runLabel || Date.parse(manifest.createdAt) > now().getTime()
      || new Set(manifest.executionIds).size !== manifest.executionIds.length
      || manifest.executionIds.length !== inventory.participants.length
      || manifest.executionIds.some((id: number): boolean => !inventory.participants.some((participant): boolean => participant.player.id === id))) {
      throw new Error("Fixture checkpoint inventory or identity associations changed. Restore verified state or use a new run label; no checkpoint was rewritten.");
    }
    if (saved === null) await writeLocalJson(file, manifest);
    throwIfAborted(budget.totalSignal);
    const byId = new Map(inventory.participants.map((participant): readonly [number, PlayerIdentity] => [participant.player.id, participant.player]));
    const ordered = manifest.executionIds.map((id: number): PlayerIdentity => {
      const player = byId.get(id);
      if (player === undefined) throw new Error("Fixture checkpoint contains an unknown participant.");
      return player;
    });
    const byName = new Map(ordered.map((player: PlayerIdentity): readonly [string, PlayerIdentity] => [player.name, player]));
    let collection: ResearchCollectionResult | null = null;
    if (ordered.length > 0 && !budget.workSignal.aborted && budget.workRemainingMs() > 0) {
      collection = await collectResearchBatch({ version: 1, runLabel: runId, players: ordered.map((player: PlayerIdentity): string => player.name) }, {
        directory: path.join(manifestDirectory, "jobs", runId), ledger: options.ledger, now, budget,
        canonicalParticipants: byName,
        reader: { getLastMatchesSnapshot: async (name: string, count: number, upstream?: AbortSignal): Promise<ResearchHistoryRead> => {
          const player = byName.get(name);
          if (player === undefined) throw new Error("Unverified fixture participant requested.");
          // getResolvedMatchesSnapshot revalidates freshness, scope and identity at use, not only at planning.
          return options.reader.getResolvedMatchesSnapshot(player, count, upstream);
        } },
      }, signal);
    }
    const outcomes = inventory.participants.map((participant): FixtureParticipantOutcome => {
      const row = collection?.checkpoint.rows.find((item): boolean => item.canonicalPlayerId === participant.player.id
        || item.requestedName === participant.player.name);
      return { playerId: participant.player.id, status: row?.status === "complete" ? "complete"
        : row === undefined || row.failure === "DEADLINE" ? "deferred-deadline" : "failed",
        evidenceId: row?.evidenceId ?? null, failure: row?.failure ?? (row === undefined ? "DEADLINE" : null) };
    });
    const outcomeById = new Map(outcomes.map((outcome): readonly [number, FixtureParticipantOutcome] => [outcome.playerId, outcome]));
    const counts = { total: inventory.references.length, complete: 0, failed: 0, deferred: 0, unresolved: 0, excluded: 0 };
    for (const reference of inventory.references) {
      if (reference.status === "excluded-limit") counts.excluded += 1;
      else if (reference.status === "unresolved") counts.unresolved += 1;
      else {
        const outcome = outcomeById.get(reference.participantId);
        if (outcome === undefined) throw new Error("Fixture reference has no participant outcome.");
        if (outcome.status === "complete") counts.complete += 1;
        else if (outcome.status === "failed") counts.failed += 1;
        else counts.deferred += 1;
      }
    }
    if (counts.total !== counts.complete + counts.failed + counts.deferred + counts.unresolved + counts.excluded) throw new Error("Fixture inventory accounting failed.");
    throwIfAborted(signal);
    return { version: 2, inventory, plan, outcomes, collection, status: counts.complete === counts.total ? "complete" : "partial", referenceCounts: counts, deliveryAuthorized: false };
  });
  try { return await waitWithSignal(operation, budget.totalSignal); }
  finally { if (options.budget === undefined) budget.close(); }
}
