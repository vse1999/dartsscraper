import { IsoDateSchema } from "../agent/date.js";
import type { CacheStore } from "../cache.js";
import { noopLogger, type Logger } from "../logger.js";
import { SnapshotStore, type SnapshotRead } from "../services/snapshot-store.js";
import {
  ModusResultsSnapshotSchema,
  type ModusResultsSnapshot,
} from "./results-schemas.js";
import type { OfficialModusResultsSource } from "./official-results-source.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_FRESH_TTL_MS = 10_000;
const DEFAULT_MAX_STALE_MS = 5 * 60_000;
const DEFAULT_REFRESH_INTERVAL_MS = 10_000;
const MAX_DATE_STORES = 8;

export interface OfficialModusResultsServiceOptions {
  source: Pick<OfficialModusResultsSource, "getResults">;
  cache?: CacheStore;
  cacheTtlMs?: number;
  freshTtlMs?: number;
  maxStaleMs?: number;
  refreshIntervalMs?: number;
  now?: () => number;
  logger?: Logger;
}

export class OfficialModusResultsService {
  private readonly source: Pick<OfficialModusResultsSource, "getResults">;
  private readonly cache: CacheStore | undefined;
  private readonly cacheTtlMs: number;
  private readonly freshTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly refreshIntervalMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly stores = new Map<string, SnapshotStore<ModusResultsSnapshot>>();
  private readonly diskCacheChecked = new Set<string>();
  private activeDate: string | undefined;

  public constructor(options: OfficialModusResultsServiceOptions) {
    this.source = options.source;
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.freshTtlMs = options.freshTtlMs ?? DEFAULT_FRESH_TTL_MS;
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs <= 0) {
      throw new Error("Official MODUS results cacheTtlMs must be a positive finite number.");
    }
    positiveFinite(this.freshTtlMs, "freshTtlMs");
    positiveFinite(this.maxStaleMs, "maxStaleMs");
    positiveFinite(this.refreshIntervalMs, "refreshIntervalMs");
  }

  public async getResults(date: string, signal?: AbortSignal): Promise<ModusResultsSnapshot> {
    return (await this.getResultsSnapshot(date, signal)).value;
  }

  public async getResultsSnapshot(date: string, signal?: AbortSignal): Promise<SnapshotRead<ModusResultsSnapshot>> {
    const validatedDate = IsoDateSchema.parse(date);
    return this.storeFor(validatedDate).get(signal);
  }

  public async preload(date: string): Promise<SnapshotRead<ModusResultsSnapshot>> {
    const validatedDate = IsoDateSchema.parse(date);
    const store = this.storeFor(validatedDate);
    const snapshot = await store.preload();
    this.activateStore(validatedDate, store);
    return snapshot;
  }

  public async activate(date: string, signal?: AbortSignal): Promise<SnapshotRead<ModusResultsSnapshot>> {
    const validatedDate = IsoDateSchema.parse(date);
    const store = this.storeFor(validatedDate);
    const snapshot = await store.get(signal);
    this.activateStore(validatedDate, store);
    return snapshot;
  }

  public stopBackgroundRefresh(): void {
    for (const store of this.stores.values()) store.stopBackgroundRefresh();
    this.activeDate = undefined;
  }

  private activateStore(date: string, store: SnapshotStore<ModusResultsSnapshot>): void {
    if (this.activeDate !== date) {
      for (const [storedDate, stored] of this.stores) {
        if (storedDate !== date) stored.stopBackgroundRefresh();
      }
      this.activeDate = date;
    }
    store.startBackgroundRefresh(this.refreshIntervalMs);
  }

  private storeFor(date: string): SnapshotStore<ModusResultsSnapshot> {
    const existing = this.stores.get(date);
    if (existing !== undefined) return existing;
    const store = new SnapshotStore<ModusResultsSnapshot>({
      loader: async () => this.loadFresh(date),
      freshTtlMs: this.freshTtlMs,
      maxStaleMs: this.maxStaleMs,
      now: this.now,
      timestampForValue: (value) => Date.parse(value.fetchedAt),
      onBackgroundError: (error: unknown) => this.logger.warn("Official MODUS background refresh failed; keeping the last valid snapshot.", {
        date,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    });
    this.stores.set(date, store);
    this.evictOldDateStores();
    return store;
  }

  private evictOldDateStores(): void {
    while (this.stores.size > MAX_DATE_STORES) {
      const candidate = [...this.stores.keys()].find((date) => date !== this.activeDate);
      if (candidate === undefined) return;
      this.stores.get(candidate)?.stopBackgroundRefresh();
      this.stores.delete(candidate);
      this.diskCacheChecked.delete(candidate);
    }
  }

  private async loadFresh(validatedDate: string): Promise<ModusResultsSnapshot> {
    const cacheKey = `modus-official-results-v1-${validatedDate}`;
    if (!this.diskCacheChecked.has(validatedDate)) {
      this.diskCacheChecked.add(validatedDate);
      const cachedValue = await this.cache?.get(cacheKey);
      const cached = ModusResultsSnapshotSchema.safeParse(cachedValue);
      if (cached.success && this.now() - Date.parse(cached.data.fetchedAt) <= this.maxStaleMs) return cached.data;
    }

    const fresh = ModusResultsSnapshotSchema.parse(await this.source.getResults(validatedDate));
    await this.cache?.set(cacheKey, fresh, this.cacheTtlMs);
    return fresh;
  }
}

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
}
