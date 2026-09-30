import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";

const DEFAULT_DIRECTORY_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_REFRESH_COOLDOWN_MS = 30 * 1_000;

export type DirectoryLoaderFunction<T> = (
  forceRefresh: boolean,
  signal?: AbortSignal,
) => Promise<T>;

export interface DirectoryLoaderOptions {
  readonly ttlMs?: number;
  readonly refreshCooldownMs?: number;
  readonly now?: () => number;
}

interface CachedDirectory<T> {
  readonly value: T;
  readonly expiresAt: number;
  readonly version: number;
}

/** Caches a provider directory briefly and allows one coalesced miss refresh per cooldown. */
export class DirectoryLoader<T> {
  private readonly loadDirectory: DirectoryLoaderFunction<T>;
  private readonly ttlMs: number;
  private readonly refreshCooldownMs: number;
  private readonly now: () => number;
  private cached: CachedDirectory<T> | undefined;
  private sharedRequest: Promise<T> | undefined;
  private refreshRequest: Promise<T> | undefined;
  private readonly signalRequests = new WeakMap<AbortSignal, Promise<T>>();
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private requestVersion = 0;

  public constructor(loadDirectory: DirectoryLoaderFunction<T>, options: DirectoryLoaderOptions = {}) {
    this.loadDirectory = loadDirectory;
    this.ttlMs = positiveFinite(options.ttlMs ?? DEFAULT_DIRECTORY_TTL_MS, "Directory TTL");
    this.refreshCooldownMs = nonNegativeFinite(
      options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS,
      "Directory refresh cooldown",
    );
    this.now = options.now ?? Date.now;
  }

  public get(signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (this.refreshRequest !== undefined) return waitWithSignal(this.refreshRequest, signal);
    if (this.cached !== undefined && this.cached.expiresAt > this.now()) {
      return waitWithSignal(Promise.resolve(this.cached.value), signal);
    }
    if (this.sharedRequest !== undefined) return waitWithSignal(this.sharedRequest, signal);

    // Expiry must bypass the client's longer-lived raw response cache too.
    const forceRefresh = this.cached !== undefined;
    if (forceRefresh) this.lastRefreshAt = this.now();
    if (signal === undefined) return this.startSharedLoad(forceRefresh);
    const signalRequest = this.signalRequests.get(signal);
    if (signalRequest !== undefined) return waitWithSignal(signalRequest, signal);
    const version = this.nextVersion();
    const request = this.loadDirectory(forceRefresh, signal).then(
      (directory: T): T => {
        if (!signal.aborted) this.cache(directory, version);
        if (this.signalRequests.get(signal) === request) this.signalRequests.delete(signal);
        return directory;
      },
      (error: unknown): never => {
        if (this.signalRequests.get(signal) === request) this.signalRequests.delete(signal);
        throw error;
      },
    );
    this.signalRequests.set(signal, request);
    return waitWithSignal(request, signal);
  }

  /** Force one provider refresh after a genuine miss; callers share the work and may cancel their own wait. */
  public refreshAfterMiss(signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (this.refreshRequest !== undefined) return waitWithSignal(this.refreshRequest, signal);
    if (this.now() - this.lastRefreshAt < this.refreshCooldownMs) {
      if (this.cached !== undefined) return waitWithSignal(Promise.resolve(this.cached.value), signal);
      return this.get(signal);
    }

    this.lastRefreshAt = this.now();
    const inProgressLoad = this.sharedRequest;
    const forcedLoad = inProgressLoad === undefined
      ? this.startSharedLoad(true)
      : inProgressLoad.then(
          (): Promise<T> => this.startSharedLoad(true),
          (): Promise<T> => this.startSharedLoad(true),
        );
    const request = forcedLoad.then(
      (directory: T): T => {
        if (this.refreshRequest === request) this.refreshRequest = undefined;
        return directory;
      },
      (error: unknown): never => {
        if (this.refreshRequest === request) this.refreshRequest = undefined;
        throw error;
      },
    );
    this.refreshRequest = request;
    return waitWithSignal(request, signal);
  }

  private startSharedLoad(forceRefresh: boolean): Promise<T> {
    const existing = this.sharedRequest;
    if (existing !== undefined) return existing;
    const version = this.nextVersion();
    const request = this.loadDirectory(forceRefresh).then(
      (directory: T): T => {
        this.cache(directory, version);
        if (this.sharedRequest === request) this.sharedRequest = undefined;
        return directory;
      },
      (error: unknown): never => {
        if (this.sharedRequest === request) this.sharedRequest = undefined;
        throw error;
      },
    );
    this.sharedRequest = request;
    return request;
  }

  private cache(directory: T, version: number): void {
    if (this.cached !== undefined && this.cached.version > version) return;
    this.cached = {
      value: directory,
      expiresAt: this.now() + this.ttlMs,
      version,
    };
  }

  private nextVersion(): number {
    this.requestVersion += 1;
    return this.requestVersion;
  }
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`);
  return value;
}
