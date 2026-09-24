/**
 * Throw the caller's cancellation reason (or a stable fallback) when an
 * operation has been cancelled.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw abortError(signal);
}

export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("Operation was cancelled.");
}

/**
 * Stop waiting for a shared operation without cancelling that operation. This
 * is important for cached/single-flight work whose other consumers may still
 * need the result.
 */
export async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The signal can abort between the initial check and listener
    // registration. Recheck so queued work never proceeds in that window.
    if (signal.aborted) onAbort();
    promise.then(
      (value: T): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
