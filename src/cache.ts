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
