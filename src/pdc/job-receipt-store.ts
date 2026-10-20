export interface PdcJobReceipt {
  readonly signature: string;
  readonly expiresAt: number;
}

export type PdcJobReceiptReservation = "reserved" | "duplicate" | "conflict" | "capacity_reached";

/**
 * Atomic duplicate-receipt boundary for the continuation endpoint.
 *
 * A future shared adapter must implement reserve as one conditional operation;
 * a separate read followed by a write is not safe across instances. Release
 * also compares the signature so stale cleanup cannot remove a newer receipt.
 */
export interface PdcJobReceiptStore {
  reserve(key: string, receipt: PdcJobReceipt, now: number): Promise<PdcJobReceiptReservation>;
  release(key: string, signature: string): Promise<void>;
}

export interface InMemoryPdcJobReceiptStoreOptions {
  readonly maxEntries?: number;
}

/** Process-local duplicate suppression only; this is not durable job admission. */
export class InMemoryPdcJobReceiptStore implements PdcJobReceiptStore {
  private readonly receipts = new Map<string, PdcJobReceipt>();
  private readonly maxEntries: number;

  public constructor(options: InMemoryPdcJobReceiptStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1024;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error("PDC receipt capacity must be a positive safe integer.");
    }
  }

  public async reserve(key: string, receipt: PdcJobReceipt, now: number): Promise<PdcJobReceiptReservation> {
    if (key.trim() === "") throw new Error("PDC receipt key must not be empty.");
    if (receipt.signature.trim() === "") throw new Error("PDC receipt signature must not be empty.");
    if (!Number.isFinite(now) || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now) {
      throw new Error("PDC receipt expiry must be a finite time after now.");
    }

    for (const [storedKey, storedReceipt] of this.receipts) {
      if (storedReceipt.expiresAt <= now) this.receipts.delete(storedKey);
    }

    const previous = this.receipts.get(key);
    if (previous !== undefined) return previous.signature === receipt.signature ? "duplicate" : "conflict";
    if (this.receipts.size >= this.maxEntries) return "capacity_reached";
    this.receipts.set(key, receipt);
    return "reserved";
  }

  public async release(key: string, signature: string): Promise<void> {
    if (this.receipts.get(key)?.signature === signature) this.receipts.delete(key);
  }
}
