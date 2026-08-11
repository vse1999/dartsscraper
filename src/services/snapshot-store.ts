export interface SnapshotRead<T> {
  value: T;
  fetchedAt: string;
  dataAgeMs: number;
  stale: boolean;
}

export interface SnapshotStoreOptions<T> {
  loader: () => Promise<T>;
  freshTtlMs: number;
  maxStaleMs: number;
  backgroundRetryDelayMs?: number;
  timestampForValue?: (value: T) => number;
  now?: () => number;
  onBackgroundError?: (error: unknown) => void;
}

interface SnapshotEntry<T> {
  value: T;
  fetchedAtMs: number;
}

export class SnapshotStore<T> {
  private readonly loader: () => Promise<T>;
  private readonly freshTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly backgroundRetryDelayMs: number;
  private readonly now: () => number;
  private readonly timestampForValue: ((value: T) => number) | undefined;
  private readonly onBackgroundError: ((error: unknown) => void) | undefined;
  private entry: SnapshotEntry<T> | undefined;
  private inFlight: Promise<SnapshotEntry<T>> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private lastFailureAtMs: number | undefined;

  public constructor(options: SnapshotStoreOptions<T>) {
    this.loader = options.loader;
    this.freshTtlMs = positiveFinite(options.freshTtlMs, "freshTtlMs");
    this.maxStaleMs = positiveFinite(options.maxStaleMs, "maxStaleMs");
    this.backgroundRetryDelayMs = positiveFinite(
      options.backgroundRetryDelayMs ?? Math.min(this.freshTtlMs, 5_000),
      "backgroundRetryDelayMs",
    );
    if (this.maxStaleMs < this.freshTtlMs) {
      throw new Error("maxStaleMs must be greater than or equal to freshTtlMs.");
    }
    this.now = options.now ?? Date.now;
    this.timestampForValue = options.timestampForValue;
    this.onBackgroundError = options.onBackgroundError;
  }

  public async get(signal?: AbortSignal): Promise<SnapshotRead<T>> {
    throwIfAborted(signal);
    const current = this.entry;
    if (current !== undefined) {
      const ageMs = Math.max(0, this.now() - current.fetchedAtMs);
      if (ageMs <= this.freshTtlMs) return toRead(current, ageMs, false);
      if (ageMs <= this.maxStaleMs) {
        this.refreshInBackground();
        return toRead(current, ageMs, true);
      }
    }

    const refreshed = await waitWithSignal(this.refresh(), signal);
    return this.readRefreshed(refreshed);
  }

  public async preload(): Promise<SnapshotRead<T>> {
    const refreshed = await this.refresh();
    return this.readRefreshed(refreshed);
  }

  public startBackgroundRefresh(intervalMs: number): void {
    const validatedInterval = positiveFinite(intervalMs, "intervalMs");
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = setInterval(() => this.refreshInBackground(), validatedInterval);
    this.refreshTimer.unref();
  }

  public stopBackgroundRefresh(): void {
    if (this.refreshTimer === undefined) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private refreshInBackground(): void {
    if (this.lastFailureAtMs !== undefined && this.now() - this.lastFailureAtMs < this.backgroundRetryDelayMs) return;
    void this.refresh().catch((error: unknown) => this.onBackgroundError?.(error));
  }

  private refresh(): Promise<SnapshotEntry<T>> {
    if (this.inFlight !== undefined) return this.inFlight;
    let loaded: Promise<T>;
    try {
      loaded = Promise.resolve(this.loader());
    } catch (error: unknown) {
      loaded = Promise.reject(error);
    }
    const request = loaded.then((value): SnapshotEntry<T> => {
      const observedTimestamp = this.timestampForValue?.(value) ?? this.now();
      if (!Number.isFinite(observedTimestamp)) {
        throw new Error("Snapshot loader returned a value with an invalid timestamp.");
      }
      const entry = { value, fetchedAtMs: Math.min(observedTimestamp, this.now()) };
      this.entry = entry;
      this.lastFailureAtMs = undefined;
      return entry;
    }).catch((error: unknown) => {
      this.lastFailureAtMs = this.now();
      throw error;
    }).finally(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    });
    this.inFlight = request;
    return request;
  }

  private readRefreshed(entry: SnapshotEntry<T>): SnapshotRead<T> {
    const ageMs = Math.max(0, this.now() - entry.fetchedAtMs);
    if (ageMs > this.maxStaleMs) {
      this.entry = undefined;
      throw new Error(`Snapshot source returned data older than the ${this.maxStaleMs} ms safety limit.`);
    }
    const stale = ageMs > this.freshTtlMs;
    if (stale) this.refreshInBackground();
    return toRead(entry, ageMs, stale);
  }
}

function toRead<T>(entry: SnapshotEntry<T>, dataAgeMs: number, stale: boolean): SnapshotRead<T> {
  return {
    value: entry.value,
    fetchedAt: new Date(entry.fetchedAtMs).toISOString(),
    dataAgeMs,
    stale,
  };
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("Snapshot request was cancelled.");
}

async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("Snapshot request was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
