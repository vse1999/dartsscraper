import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EvidenceIdSchema, validateEvidenceSnapshot, type EvidenceSnapshot } from "./evidence.js";

export interface EvidenceLedger {
  write(snapshot: EvidenceSnapshot): Promise<void>;
  read(id: string): Promise<EvidenceSnapshot | null>;
  latest(playerId: number, dateTo: string, minimumCount: number): Promise<EvidenceSnapshot | null>;
}
export interface EvidenceLedgerOptions {
  readonly now?: () => Date;
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function validateLookup(playerId: number, dateTo: string, minimumCount: number): void {
  if (!Number.isSafeInteger(playerId) || playerId <= 0 || !/^\d{4}-\d{2}-\d{2}$/u.test(dateTo)
    || !Number.isFinite(Date.parse(dateTo)) || new Date(dateTo).toISOString().slice(0, 10) !== dateTo
    || !Number.isSafeInteger(minimumCount) || minimumCount <= 0 || minimumCount > 1000) {
    throw new Error("Invalid evidence lookup: use canonical player ID, calendar cutoff and bounded positive count.");
  }
}
function selectLatest(records: readonly EvidenceSnapshot[], playerId: number, dateTo: string, minimumCount: number): EvidenceSnapshot | null {
  validateLookup(playerId, dateTo, minimumCount);
  return records.filter((item) => item.player.id === playerId && item.dateTo === dateTo && item.requestedCount >= minimumCount)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || right.id.localeCompare(left.id))[0] ?? null;
}
function boundedInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${label} must be a positive safe integer no greater than ${maximum}.`);
  return value;
}

export class MemoryEvidenceLedger implements EvidenceLedger {
  private readonly records = new Map<string, EvidenceSnapshot>();
  private readonly now: () => Date;
  private readonly maxRecords: number;
  public constructor(options: EvidenceLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxRecords = boundedInteger(options.maxRecords ?? 1_000, "Evidence record limit", 100_000);
  }
  public async write(snapshot: EvidenceSnapshot): Promise<void> {
    const parsed = validateEvidenceSnapshot(snapshot, this.now());
    if (!this.records.has(parsed.id) && this.records.size >= this.maxRecords) throw new Error("Evidence ledger is full; archive records explicitly before collecting more.");
    this.records.set(parsed.id, parsed);
  }
  public async read(id: string): Promise<EvidenceSnapshot | null> {
    EvidenceIdSchema.parse(id);
    const value = this.records.get(id);
    return value === undefined ? null : validateEvidenceSnapshot(value, this.now());
  }
  public async latest(playerId: number, dateTo: string, minimumCount: number): Promise<EvidenceSnapshot | null> {
    const values = [...this.records.values()].map((value) => validateEvidenceSnapshot(value, this.now()));
    return selectLatest(values, playerId, dateTo, minimumCount);
  }
}

/** Opt-in single-host storage. Exclusive directory ownership plus rename publishes complete records. */
export class FileEvidenceLedger implements EvidenceLedger {
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private writes: Promise<void> = Promise.resolve();
  public constructor(directory: string, options: EvidenceLedgerOptions = {}) {
    if (directory.trim().length === 0) throw new Error("Evidence directory must not be empty.");
    this.directory = resolve(directory);
    this.now = options.now ?? (() => new Date());
    this.maxRecords = boundedInteger(options.maxRecords ?? 1_000, "Evidence record limit", 100_000);
    this.maxBytes = boundedInteger(options.maxBytes ?? 2_000_000, "Evidence file byte limit", 10_000_000);
  }
  public async write(snapshot: EvidenceSnapshot): Promise<void> {
    // Serialize count-check/publication in this instance; the runner separately owns an exclusive host lock.
    const parsed = validateEvidenceSnapshot(snapshot, this.now());
    const operation = this.writes.then(() => this.publish(parsed));
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  private async publish(snapshot: EvidenceSnapshot): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const lock = join(this.directory, ".write-lock");
    try { await mkdir(lock); }
    catch (error: unknown) {
      throw new Error("Evidence ledger is locked by another writer; retry later or recover a stale lock only after confirming no writer is active.", { cause: error });
    }
    try { await this.publishOwned(snapshot); }
    finally { await rmdir(lock); }
  }
  private async publishOwned(snapshot: EvidenceSnapshot): Promise<void> {
    const existing = await this.read(snapshot.id);
    if (existing !== null) return;
    if ((await this.recordIds()).length >= this.maxRecords) throw new Error("Evidence ledger is full; archive records explicitly before collecting more.");
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body) > this.maxBytes) throw new Error("Evidence record exceeds configured byte limit.");
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(body, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      // All compliant writers hold the directory lock; the existing immutable ID was checked above.
      await rename(temporary, this.path(snapshot.id));
    } finally {
      try { await unlink(temporary); }
      catch (error: unknown) { if (errorCode(error) !== "ENOENT") throw error; }
    }
  }
  private path(id: string): string {
    return join(this.directory, `${EvidenceIdSchema.parse(id)}.json`);
  }
  public async read(id: string): Promise<EvidenceSnapshot | null> {
    const path = this.path(id);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Cannot open evidence record; check storage permissions and file integrity.", { cause: error });
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > this.maxBytes) throw new Error("Evidence record is not a bounded regular file.");
      // Bound the actual read too: another process might grow the file after stat.
      const bytes = Buffer.alloc(metadata.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await handle.read(bytes, count, bytes.length - count, count);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      if (count > metadata.size) throw new Error("Evidence record changed during its immutable read.");
      const value: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
      const snapshot = validateEvidenceSnapshot(value, this.now());
      if (snapshot.id !== id) throw new Error("Evidence filename does not match its content ID.");
      return snapshot;
    } catch (error: unknown) {
      throw new Error(`Evidence record ${id} is unreadable or corrupt; restore verified evidence before reuse.`, { cause: error });
    } finally { await handle.close(); }
  }
  private async recordIds(): Promise<string[]> {
    let entries: string[];
    try { entries = await readdir(this.directory); }
    catch (error: unknown) { if (errorCode(error) === "ENOENT") return []; throw error; }
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry === ".write-lock") continue;
      if (entry.startsWith(".") && entry.endsWith(".tmp")) continue;
      if (!/^[a-f0-9]{64}\.json$/u.test(entry)) throw new Error("Evidence directory contains an unexpected file; use a dedicated private directory.");
      ids.push(entry.slice(0, -5));
      if (ids.length > this.maxRecords) throw new Error("Evidence directory exceeds configured record limit.");
    }
    return ids;
  }
  public async latest(playerId: number, dateTo: string, minimumCount: number): Promise<EvidenceSnapshot | null> {
    validateLookup(playerId, dateTo, minimumCount);
    const records: EvidenceSnapshot[] = [];
    for (const id of await this.recordIds()) {
      const record = await this.read(id);
      if (record === null) throw new Error("Evidence disappeared during lookup; retry after storage maintenance finishes.");
      records.push(record);
    }
    return selectLatest(records, playerId, dateTo, minimumCount);
  }
}
