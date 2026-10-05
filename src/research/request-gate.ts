import path from "node:path";
import { mkdir, open, unlink } from "node:fs/promises";
import { z } from "zod";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { localErrorCode, readLocalJson, writeLocalJson } from "./local-files.js";

const GateStateSchema = z.object({ version: z.literal(1), nextAt: z.number().int().nonnegative() }).strict();

/** Shared single-host request reservations; this is not a cross-host/serverless quota backend. */
export class LocalRequestGate {
  public constructor(private readonly directory: string, private readonly intervalMs: number = 3_200) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 3_200 || intervalMs > 60_000) {
      throw new Error("Local Reader request spacing must be between 3200 and 60000 milliseconds.");
    }
  }

  public async acquire(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10_000;
    await waitWithSignal(mkdir(this.directory, { recursive: true }), signal);
    while (true) {
      throwIfAborted(signal);
      const lockPath = path.join(this.directory, "reader.lock");
      let handle;
      try { handle = await open(lockPath, "wx", 0o600); }
      catch (error: unknown) {
        if (localErrorCode(error) !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Reader reservation is locked. Inspect the local reader lock after confirming no collector is active; it is never stolen automatically.");
        await delay(25, signal);
        continue;
      }
      let waitMs = 0;
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
        const saved = await readLocalJson(path.join(this.directory, "reader-state.json"), 1_024);
        const state = saved === null ? { version: 1 as const, nextAt: 0 } : GateStateSchema.parse(saved);
        waitMs = Math.max(0, state.nextAt - Date.now());
        if (waitMs > 60_000) throw new Error("Reader reservation clock is inconsistent. Inspect state and clock before resuming collection.");
        if (waitMs === 0) {
          throwIfAborted(signal);
          await writeLocalJson(path.join(this.directory, "reader-state.json"), { version: 1, nextAt: Date.now() + this.intervalMs });
        }
      } finally {
        await handle.close();
        await unlink(lockPath);
      }
      if (waitMs === 0) { throwIfAborted(signal); return; }
      await delay(waitMs, signal);
    }
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const pending = new Promise<void>((resolve): void => { timer = setTimeout(resolve, milliseconds); });
  return waitWithSignal(pending, signal).finally((): void => clearTimeout(timer));
}

export function withLocalReaderGate(fetchImpl: typeof fetch, directory: string): typeof fetch {
  const gate = new LocalRequestGate(directory);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    await gate.acquire(signal ?? undefined);
    return fetchImpl(input, init);
  };
}
