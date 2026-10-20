import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";

const CacheEnvelopeSchema = z.object({
  expiresAt: z.number().finite(),
  value: z.unknown(),
});

export interface CacheStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

export interface MemoryCacheOptions {
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface MemoryCacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/** Bounded process-local cache for serverless runtimes with no writable durable filesystem. */
export class MemoryCache implements CacheStore {
  private readonly entries = new Map<string, MemoryCacheEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  public constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) throw new Error("Memory cache capacity must be a positive safe integer.");
  }

  public async get(key: string): Promise<unknown | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  public async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Cache TTL must be a positive finite number.");
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface FileCacheOptions {
  directory: string;
  logger?: Logger;
  now?: () => number;
}

export class FileCache implements CacheStore {
  private readonly directory: string;
  private readonly logger: Logger;
  private readonly now: () => number;

  public constructor(options: FileCacheOptions) {
    this.directory = options.directory;
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? Date.now;
  }

  public async get(key: string): Promise<unknown | null> {
    const filePath = this.filePath(key);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const envelope = CacheEnvelopeSchema.safeParse(parsed);
      if (!envelope.success || envelope.data.expiresAt <= this.now()) {
        return null;
      }
      return envelope.data.value;
    } catch (error: unknown) {
      const code = this.errorCode(error);
      if (code !== "ENOENT") {
        this.logger.warn("Ignoring unreadable cache entry.", { key, code });
      }
      return null;
    }
  }

  public async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Cache TTL must be a positive finite number.");
    }
    const envelope = {
      expiresAt: this.now() + ttlMs,
      value,
    };
    const filePath = this.filePath(key);
    let temporaryPath: string | undefined;
    try {
      await mkdir(this.directory, { recursive: true });
      temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(envelope), "utf8");
      await rename(temporaryPath, filePath);
    } catch (error: unknown) {
      if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => undefined);
      this.logger.warn("Unable to write cache entry; continuing without cache.", {
        key,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  private filePath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }

  private errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return undefined;
    }
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
}

/**
 * Returns a persistent FileCache for local execution environments and a bounded
 * MemoryCache for serverless environments (e.g. Vercel).
 */
export function createDefaultDartsCache(logger?: Logger, env: NodeJS.ProcessEnv = process.env): CacheStore {
  if (env.RESEARCH_LOCAL_LEDGER_ENABLED === "true" && env.VERCEL !== "1" && env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
    return new FileCache({
      directory: path.resolve(process.cwd(), ".cache", "dartsorakel"),
      ...(logger === undefined ? {} : { logger }),
    });
  }
  return new MemoryCache({ maxEntries: 512 });
}
