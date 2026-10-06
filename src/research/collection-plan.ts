import { PlayerIdentitySchema, type PlayerIdentity } from "../schemas/player.js";
import { validateLimit } from "../services/player-matches.js";

export interface CollectionParticipant {
  readonly player: PlayerIdentity;
  readonly inventoryIndex: number;
  readonly startTime: string | null;
}

export interface CollectionPlanItem extends CollectionParticipant {
  readonly action: "reuse-candidate" | "acquire-candidate";
  readonly requestedCount: number;
}

export interface CollectionPlan {
  readonly version: 1;
  readonly items: readonly CollectionPlanItem[];
  readonly modeledStatisticViews: number;
  readonly modelIsAdmissionGuarantee: false;
}

/** Pure scheduling, not player ranking; cache inspection cannot perform network I/O. */
export function buildCollectionPlan(
  participants: readonly CollectionParticipant[],
  hasFreshSnapshot: (player: PlayerIdentity, count: number) => boolean,
  requestedCount: number = 20,
): CollectionPlan {
  validateLimit(requestedCount);
  if (participants.length > 100) throw new Error("Collection plan exceeds the 100-participant limit.");
  const ids = new Set<number>();
  const indices = new Set<number>();
  const items = participants.map((participant: CollectionParticipant): CollectionPlanItem => {
    const player = PlayerIdentitySchema.parse(participant.player);
    if (!Number.isSafeInteger(participant.inventoryIndex) || participant.inventoryIndex < 0 || indices.has(participant.inventoryIndex)) {
      throw new Error("Collection inventory indices must be unique nonnegative integers.");
    }
    if (ids.has(player.id)) throw new Error("Collection planning requires deduplicated canonical participants.");
    if (participant.startTime !== null && (!Number.isFinite(Date.parse(participant.startTime)) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(participant.startTime))) {
      throw new Error("Collection start time must be an offset-bearing timestamp or unknown.");
    }
    ids.add(player.id); indices.add(participant.inventoryIndex);
    return { ...participant, player, requestedCount, action: hasFreshSnapshot(player, requestedCount) ? "reuse-candidate" : "acquire-candidate" };
  });
  items.sort((left: CollectionPlanItem, right: CollectionPlanItem): number => {
    if (left.action !== right.action) return left.action === "reuse-candidate" ? -1 : 1;
    const first = left.startTime === null ? Infinity : Date.parse(left.startTime);
    const second = right.startTime === null ? Infinity : Date.parse(right.startTime);
    return (first === second ? 0 : first - second) || left.inventoryIndex - right.inventoryIndex;
  });
  return { version: 1, items, modeledStatisticViews: items.filter((item: CollectionPlanItem): boolean => item.action === "acquire-candidate").length * 3,
    modelIsAdmissionGuarantee: false };
}
