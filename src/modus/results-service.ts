import { IsoDateSchema } from "../agent/date.js";
import type { CacheStore } from "../cache.js";
import {
  ModusResultsSnapshotSchema,
  type ModusResultsSnapshot,
} from "./results-schemas.js";
import type { OfficialModusResultsSource } from "./official-results-source.js";

const DEFAULT_CACHE_TTL_MS = 15_000;

export interface OfficialModusResultsServiceOptions {
  source: Pick<OfficialModusResultsSource, "getResults">;
  cache?: CacheStore;
  cacheTtlMs?: number;
}

export class OfficialModusResultsService {
  private readonly source: Pick<OfficialModusResultsSource, "getResults">;
  private readonly cache: CacheStore | undefined;
  private readonly cacheTtlMs: number;

  public constructor(options: OfficialModusResultsServiceOptions) {
    this.source = options.source;
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs <= 0) {
      throw new Error("Official MODUS results cacheTtlMs must be a positive finite number.");
    }
  }

  public async getResults(date: string, signal?: AbortSignal): Promise<ModusResultsSnapshot> {
    const validatedDate = IsoDateSchema.parse(date);
    throwIfAborted(signal);
    const cacheKey = `modus-official-results-v1-${validatedDate}`;
    const cachedValue = await this.cache?.get(cacheKey);
    throwIfAborted(signal);
    const cached = ModusResultsSnapshotSchema.safeParse(cachedValue);
    if (cached.success) return cached.data;

    const fresh = ModusResultsSnapshotSchema.parse(await this.source.getResults(validatedDate, signal));
    await this.cache?.set(cacheKey, fresh, this.cacheTtlMs);
    return fresh;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("Official MODUS results request was cancelled.");
}
