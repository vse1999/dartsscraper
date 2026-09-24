export const TELEGRAM_MIN_CHAT_INTERVAL_MS = 1_000;
export const TELEGRAM_MAX_RETRIES = 2;
export const TELEGRAM_MAX_RETRY_AFTER_MS = 10_000;
export const TELEGRAM_MAX_TOTAL_RETRY_WAIT_MS = 20_000;

export interface TelegramAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface TelegramDeliveryPolicyOptions {
  readonly minIntervalMs?: number;
  readonly maxRetries?: number;
  readonly maxRetryAfterMs?: number;
  readonly maxTotalRetryWaitMs?: number;
  readonly now?: () => number;
  readonly sleep?: TelegramDeliverySleep;
}

export type TelegramDeliverySleep = (
  delayMs: number,
  signal?: TelegramAbortSignal,
) => Promise<void>;

export interface TelegramDeliveryExecuteOptions<T> {
  readonly signal?: TelegramAbortSignal;
  readonly retryAfterFromResult?: (value: T) => number | undefined;
  readonly retryAfterFromError?: (error: unknown) => number | undefined;
}

export interface TelegramDeliveryPolicy {
  execute<T>(
    chatKey: string,
    operation: (signal?: TelegramAbortSignal) => Promise<T>,
    options?: TelegramDeliveryExecuteOptions<T>,
  ): Promise<T>;
}

/** A Telegram flood-control error that is safe to retry after the specified delay. */
export class TelegramRateLimitError extends Error {
  public readonly retryAfterSeconds: number;

  public constructor(retryAfterSeconds: number) {
    super(`Telegram requested a retry after ${retryAfterSeconds} seconds.`);
    this.name = "TelegramRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface QueuedDelivery {
  readonly run: () => Promise<void>;
  readonly signal?: TelegramAbortSignal;
  started: boolean;
  removeAbortListener?: () => void;
}

interface ChatQueue {
  readonly items: QueuedDelivery[];
  processing: boolean;
  lastStartedAt?: number;
  cleanupTimer: ReturnType<typeof setTimeout> | undefined;
}

export function createTelegramDeliveryPolicy(
  options: TelegramDeliveryPolicyOptions = {},
): TelegramDeliveryPolicy {
  const minIntervalMs = options.minIntervalMs ?? TELEGRAM_MIN_CHAT_INTERVAL_MS;
  const maxRetries = options.maxRetries ?? TELEGRAM_MAX_RETRIES;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? TELEGRAM_MAX_RETRY_AFTER_MS;
  const maxTotalRetryWaitMs = options.maxTotalRetryWaitMs ?? TELEGRAM_MAX_TOTAL_RETRY_WAIT_MS;
  validateNonNegativeInteger("minIntervalMs", minIntervalMs);
  validateNonNegativeInteger("maxRetries", maxRetries);
  validatePositiveInteger("maxRetryAfterMs", maxRetryAfterMs);
  validatePositiveInteger("maxTotalRetryWaitMs", maxTotalRetryWaitMs);

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepWithAbort;
  const queues = new Map<string, ChatQueue>();

  const execute = <T>(
    chatKey: string,
    operation: (signal?: TelegramAbortSignal) => Promise<T>,
    executeOptions: TelegramDeliveryExecuteOptions<T> = {},
  ): Promise<T> => {
    if (chatKey.trim() === "") throw new Error("Telegram delivery chat key must not be empty.");
    throwIfAborted(executeOptions.signal);

    const queue = queues.get(chatKey) ?? { items: [], processing: false, cleanupTimer: undefined } satisfies ChatQueue;
    if (queue.cleanupTimer !== undefined) {
      clearTimeout(queue.cleanupTimer);
      queue.cleanupTimer = undefined;
    }
    queues.set(chatKey, queue);

    return new Promise<T>((resolve, reject) => {
      const item: QueuedDelivery = {
        started: false,
        ...(executeOptions.signal === undefined ? {} : { signal: executeOptions.signal }),
        run: async (): Promise<void> => {
          try {
            const value = await runWithRetries(
              queue,
              operation,
              executeOptions,
            );
            resolve(value);
          } catch (error: unknown) {
            reject(error);
          }
        },
      };

      const onAbort = (): void => {
        if (item.started) return;
        const index = queue.items.indexOf(item);
        if (index < 0) return;
        queue.items.splice(index, 1);
        item.removeAbortListener?.();
        reject(createAbortError());
        removeQueueIfIdle(chatKey, queue);
      };
      if (executeOptions.signal !== undefined) {
        executeOptions.signal.addEventListener("abort", onAbort, { once: true });
        item.removeAbortListener = (): void => {
          executeOptions.signal?.removeEventListener("abort", onAbort);
        };
      }

      queue.items.push(item);
      item.removeAbortListener ??= (): void => undefined;
      if (!queue.processing) {
        queue.processing = true;
        void drainQueue(chatKey, queue);
      }
    });
  };

  async function drainQueue(chatKey: string, queue: ChatQueue): Promise<void> {
    try {
      while (queue.items.length > 0) {
        const item = queue.items.shift();
        if (item === undefined) continue;
        item.started = true;
        item.removeAbortListener?.();
        await item.run();
      }
    } finally {
      queue.processing = false;
      removeQueueIfIdle(chatKey, queue);
      if (queue.items.length > 0 && !queue.processing) {
        queue.processing = true;
        void drainQueue(chatKey, queue);
      }
    }
  }

  function removeQueueIfIdle(chatKey: string, queue: ChatQueue): void {
    if (queue.processing || queue.items.length > 0 || queues.get(chatKey) !== queue) return;
    if (queue.lastStartedAt === undefined) {
      queues.delete(chatKey);
      return;
    }
    const delay = Math.max(0, queue.lastStartedAt + minIntervalMs - now());
    if (delay === 0) {
      queues.delete(chatKey);
      return;
    }
    queue.cleanupTimer = setTimeout((): void => {
      queue.cleanupTimer = undefined;
      removeQueueIfIdle(chatKey, queue);
    }, delay);
    unrefTimer(queue.cleanupTimer);
  }

  async function runWithRetries<T>(
    queue: ChatQueue,
    operation: (signal?: TelegramAbortSignal) => Promise<T>,
    executeOptions: TelegramDeliveryExecuteOptions<T>,
  ): Promise<T> {
    let retries = 0;
    let totalRetryWaitMs = 0;
    while (true) {
      await waitForStart(queue, executeOptions.signal);
      throwIfAborted(executeOptions.signal);

      let value: T;
      try {
        value = await runOperationWithCancellation(operation, executeOptions.signal);
      } catch (error: unknown) {
        const retryAfterSeconds = executeOptions.retryAfterFromError?.(error);
        if (retryAfterSeconds === undefined) throw error;
        if (!canRetry(retryAfterSeconds, retries, totalRetryWaitMs)) throw error;
        const retryAfterMs = retryAfterSeconds * 1_000;
        retries += 1;
        totalRetryWaitMs += retryAfterMs;
        await sleepWithCancellation(sleep, retryAfterMs, executeOptions.signal);
        continue;
      }

      const retryAfterSeconds = executeOptions.retryAfterFromResult?.(value);
      if (retryAfterSeconds === undefined) return value;
      if (!canRetry(retryAfterSeconds, retries, totalRetryWaitMs)) return value;
      const retryAfterMs = retryAfterSeconds * 1_000;
      retries += 1;
      totalRetryWaitMs += retryAfterMs;
      await sleepWithCancellation(sleep, retryAfterMs, executeOptions.signal);
    }
  }

  async function waitForStart(queue: ChatQueue, signal?: TelegramAbortSignal): Promise<void> {
    const previousStart = queue.lastStartedAt;
    if (previousStart !== undefined) {
      const target = previousStart + minIntervalMs;
      const delay = Math.max(0, target - now());
      if (delay > 0) await sleepWithCancellation(sleep, delay, signal);
      queue.lastStartedAt = Math.max(target, now());
    } else {
      queue.lastStartedAt = now();
    }
  }

  function canRetry(
    retryAfterSeconds: number,
    retries: number,
    totalRetryWaitMs: number,
  ): boolean {
    if (!isValidRetryAfterSeconds(retryAfterSeconds)) return false;
    if (retries >= maxRetries) return false;
    const retryAfterMs = retryAfterSeconds * 1_000;
    return retryAfterMs <= maxRetryAfterMs
      && totalRetryWaitMs <= maxTotalRetryWaitMs - retryAfterMs;
  }

  return { execute };
}

export function getTelegramRetryAfterSeconds(error: unknown): number | undefined {
  if (error instanceof TelegramRateLimitError) return error.retryAfterSeconds;
  if (!isRecord(error) || error.error_code !== 429) return undefined;
  return getRetryAfterFromParameters(error.parameters);
}

export function getTelegramRetryAfterFromResponse(value: unknown): number | undefined {
  if (!isRecord(value) || value.ok !== false || value.error_code !== 429) return undefined;
  return getRetryAfterFromParameters(value.parameters);
}

export function isValidRetryAfterSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function sleepWithCancellation(
  sleep: TelegramDeliverySleep,
  delayMs: number,
  signal?: TelegramAbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await sleep(delayMs);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(delayMs, signal).then(
      (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function runOperationWithCancellation<T>(
  operation: (signal?: TelegramAbortSignal) => Promise<T>,
  signal?: TelegramAbortSignal,
): Promise<T> {
  if (signal === undefined) return operation();
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation(signal);
    } catch (error: unknown) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (value: T): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleepWithAbort(delayMs: number, signal?: TelegramAbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout((): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function throwIfAborted(signal?: TelegramAbortSignal): void {
  if (signal?.aborted === true) throw createAbortError();
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const value: unknown = timer;
  if (typeof value !== "object" || value === null || !("unref" in value)) return;
  const unref: unknown = Reflect.get(value, "unref");
  if (typeof unref === "function") unref.call(value);
}

function createAbortError(): Error {
  const error = new Error("Telegram delivery was aborted.");
  error.name = "AbortError";
  return error;
}

function getRetryAfterFromParameters(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.retry_after !== "number") return undefined;
  return isValidRetryAfterSeconds(value.retry_after) ? value.retry_after : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Telegram delivery ${name} must be a non-negative safe integer.`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Telegram delivery ${name} must be a positive safe integer.`);
  }
}
