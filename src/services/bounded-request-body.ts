export type BoundedRequestBodyResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "too-large" };

/** Reads at most maxBytes into memory and rejects declared or streamed oversize bodies. */
export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<BoundedRequestBodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Request body limit must be a positive safe integer.");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const normalizedLength = declaredLength.trim();
    if (!/^\d+$/u.test(normalizedLength)) return { kind: "too-large" };
    const byteLength = Number(normalizedLength);
    if (!Number.isSafeInteger(byteLength) || byteLength > maxBytes) return { kind: "too-large" };
  }

  if (request.body === null) return { kind: "ok", text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > maxBytes - totalBytes) {
        void reader.cancel().catch((): void => undefined);
        return { kind: "too-large" };
      }
      totalBytes += next.value.byteLength;
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    void reader.cancel(error).catch((): void => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", text: new TextDecoder().decode(bytes) };
}
