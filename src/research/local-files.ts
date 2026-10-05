import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export function localErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Refuse overlapping work; never steal an abandoned lock or guess whether an owner is alive. */
export async function withLocalLock<T>(directory: string, name: string, operation: () => Promise<T>): Promise<T> {
  if (!/^[a-z-]+$/u.test(name)) throw new Error("Invalid local lock name.");
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, `${name}.lock`);
  const handle = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if (localErrorCode(error) === "EEXIST") throw new Error("Local research is already locked. Wait for the owner, or inspect and explicitly remove an abandoned lock after confirming collection stopped.");
    throw error;
  });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath);
  }
}

export async function writeLocalJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporary, filePath); }
  finally { await unlink(temporary).catch((error: unknown): void => { if (localErrorCode(error) !== "ENOENT") throw error; }); }
}

export async function readLocalJson(filePath: string, maxBytes: number = 1_000_000): Promise<unknown | null> {
  let handle;
  try { handle = await open(filePath, "r"); }
  catch (error: unknown) { if (localErrorCode(error) === "ENOENT") return null; throw error; }
  try {
    const size = (await handle.stat()).size;
    if (size > maxBytes) throw new Error("Local research record exceeds the permitted byte limit.");
    // Bound the read itself as well as stat: another writer must not enlarge a file during the read.
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > size) throw new Error("Local research record changed during its read; retry after the writer finishes.");
    const raw: unknown = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    return raw;
  } finally { await handle.close(); }
}
