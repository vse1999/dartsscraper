import { describe, expect, it, vi } from "vitest";

import {
  createTelegramDeliveryPolicy,
  getTelegramRetryAfterFromResponse,
  TelegramRateLimitError,
} from "../src/telegram/delivery-policy.js";
import { createTelegramSender } from "../src/telegram/sender.js";
import { createBot } from "../src/telegram/bot.js";
import type { Logger } from "../src/logger.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../src/telegram/stats-service.js";
import type { Update, UserFromGetMe } from "grammy/types";

interface FakeClock {
  now: number;
  readonly sleeps: number[];
}

function fakeClock(): FakeClock {
  return { now: 0, sleeps: [] };
}

const quietLogger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const testBotInfo: UserFromGetMe = {
  id: 777,
  is_bot: true,
  first_name: "Test Bot",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const testStatsResult: PlayerStatsResult = {
  playerName: "Rob Cross",
  requestedCount: 2,
  matches: [],
  meanAverage: null,
  availableAverageCount: 0,
  sourceUrl: "https://example.test/player/rob-cross",
  sourceLabel: "Test",
  provider: "dartsorakel",
  evidenceUrls: [],
};

const testStatsService: PlayerStatsReader = {
  getPlayerStats: async (): Promise<PlayerStatsResult> => testStatsResult,
};

function ownerUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      from: { id: 123, is_bot: false, first_name: "Owner" },
      chat: { id: 123, type: "private", first_name: "Owner" },
      text,
    },
  };
}

describe("Telegram delivery policy", () => {
  it("paces sequential and concurrent work per normalized chat without blocking another chat", async () => {
    const clock = fakeClock();
    const starts: Array<{ chat: string; at: number }> = [];
    const policy = createTelegramDeliveryPolicy({
      now: (): number => clock.now,
      sleep: async (delayMs: number): Promise<void> => {
        clock.sleeps.push(delayMs);
        clock.now += delayMs;
      },
    });

    await policy.execute("numeric:123", async (): Promise<void> => {
      starts.push({ chat: "123", at: clock.now });
    });
    await policy.execute("numeric:123", async (): Promise<void> => {
      starts.push({ chat: "123", at: clock.now });
    });
    await Promise.all([
      policy.execute("numeric:123", async (): Promise<void> => {
        starts.push({ chat: "123", at: clock.now });
      }),
      policy.execute("text:@other", async (): Promise<void> => {
        starts.push({ chat: "other", at: clock.now });
      }),
    ]);

    expect(starts).toEqual([
      { chat: "123", at: 0 },
      { chat: "123", at: 1_000 },
      { chat: "other", at: 2_000 },
      { chat: "123", at: 2_000 },
    ]);
  });

  it("retries an explicit flood-control error, but caps excessive delays", async () => {
    const clock = fakeClock();
    const policy = createTelegramDeliveryPolicy({
      minIntervalMs: 0,
      now: (): number => clock.now,
      sleep: async (delayMs: number): Promise<void> => {
        clock.sleeps.push(delayMs);
        clock.now += delayMs;
      },
    });
    let attempts = 0;
    await policy.execute("numeric:1", async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw new TelegramRateLimitError(2);
      return "sent";
    }, { retryAfterFromError: (error: unknown): number | undefined =>
      error instanceof TelegramRateLimitError ? error.retryAfterSeconds : undefined });
    expect(attempts).toBe(2);
    expect(clock.sleeps).toEqual([2_000]);

    let excessiveAttempts = 0;
    await expect(policy.execute("numeric:2", async (): Promise<void> => {
      excessiveAttempts += 1;
      throw new TelegramRateLimitError(60);
    }, { retryAfterFromError: (error: unknown): number | undefined =>
      error instanceof TelegramRateLimitError ? error.retryAfterSeconds : undefined })).rejects.toThrow();
    expect(excessiveAttempts).toBe(1);
  });

  it("does not retry ambiguous failures and recovers the queue after failure", async () => {
    const clock = fakeClock();
    const policy = createTelegramDeliveryPolicy({
      now: (): number => clock.now,
      sleep: async (delayMs: number): Promise<void> => { clock.now += delayMs; },
    });
    const starts: number[] = [];
    const first = policy.execute("numeric:1", async (): Promise<void> => {
      starts.push(clock.now);
      throw new Error("network timeout");
    });
    const second = policy.execute("numeric:1", async (): Promise<void> => {
      starts.push(clock.now);
    });
    await expect(first).rejects.toThrow("network timeout");
    await second;
    expect(starts).toEqual([0, 1_000]);
  });

  it("cancels queued work and releases an active operation that ignores its signal", async () => {
    const policy = createTelegramDeliveryPolicy({ minIntervalMs: 0 });
    let releaseFirst: (() => void) | undefined;
    const first = policy.execute("numeric:1", async (): Promise<void> => {
      await new Promise<void>((resolve: () => void): void => { releaseFirst = resolve; });
    });
    const queuedController = new AbortController();
    const queued = policy.execute("numeric:1", async (): Promise<void> => undefined, {
      signal: queuedController.signal,
    });
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst?.();
    await first;
  });

  it("cancels an active operation that ignores its signal and advances the next queued call", async () => {
    const policy = createTelegramDeliveryPolicy({ minIntervalMs: 0 });
    const activeController = new AbortController();
    let releaseActive: (() => void) | undefined;
    let secondStarted = false;
    const first = policy.execute("numeric:1", async (): Promise<void> => {
      await new Promise<void>((resolve: () => void): void => { releaseActive = resolve; });
    }, { signal: activeController.signal });
    await Promise.resolve();
    const second = policy.execute("numeric:1", async (): Promise<void> => {
      secondStarted = true;
    });
    activeController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await second;
    expect(secondStarted).toBe(true);
    releaseActive?.();
  });

  it("stops retries when the total retry wait budget would be exceeded", async () => {
    const clock = fakeClock();
    const policy = createTelegramDeliveryPolicy({
      minIntervalMs: 0,
      maxTotalRetryWaitMs: 1_500,
      now: (): number => clock.now,
      sleep: async (delayMs: number): Promise<void> => {
        clock.sleeps.push(delayMs);
        clock.now += delayMs;
      },
    });
    let attempts = 0;
    await expect(policy.execute("numeric:1", async (): Promise<void> => {
      attempts += 1;
      throw new TelegramRateLimitError(1);
    }, { retryAfterFromError: (error: unknown): number | undefined =>
      error instanceof TelegramRateLimitError ? error.retryAfterSeconds : undefined })).rejects.toThrow();
    expect(attempts).toBe(2);
    expect(clock.sleeps).toEqual([1_000]);

    const countClock = fakeClock();
    const countPolicy = createTelegramDeliveryPolicy({
      minIntervalMs: 0,
      maxRetries: 2,
      now: (): number => countClock.now,
      sleep: async (delayMs: number): Promise<void> => {
        countClock.sleeps.push(delayMs);
        countClock.now += delayMs;
      },
    });
    let countAttempts = 0;
    await expect(countPolicy.execute("numeric:2", async (): Promise<void> => {
      countAttempts += 1;
      throw new TelegramRateLimitError(1);
    }, { retryAfterFromError: (error: unknown): number | undefined =>
      error instanceof TelegramRateLimitError ? error.retryAfterSeconds : undefined })).rejects.toThrow();
    expect(countAttempts).toBe(3);
    expect(countClock.sleeps).toEqual([1_000, 1_000]);
  });

  it("cancels an in-flight retry delay", async () => {
    const controller = new AbortController();
    let resolveSleep: (() => void) | undefined;
    const policy = createTelegramDeliveryPolicy({
      minIntervalMs: 0,
      sleep: async (): Promise<void> => new Promise<void>((resolve: () => void): void => {
        resolveSleep = resolve;
      }),
    });
    const pending = policy.execute("numeric:1", async (): Promise<void> => {
      throw new TelegramRateLimitError(1);
    }, {
      signal: controller.signal,
      retryAfterFromError: (error: unknown): number | undefined =>
        error instanceof TelegramRateLimitError ? error.retryAfterSeconds : undefined,
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolveSleep?.();
  });
});

describe("Telegram sender delivery integration", () => {
  it("retries only a validated 429 and keeps the same chat policy", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const starts: number[] = [];
    const apiFetch = vi.fn<typeof fetch>().mockImplementation(async (): Promise<Response> => {
      starts.push(clock.now);
      attempts += 1;
      return attempts === 1
        ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 })
        : Response.json({ ok: true, result: {} });
    });
    const sender = createTelegramSender({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      apiFetch,
      deliveryPolicy: createTelegramDeliveryPolicy({
        minIntervalMs: 1_000,
        now: (): number => clock.now,
        sleep: async (delayMs: number): Promise<void> => { clock.now += delayMs; },
      }),
    });

    await sender.sendMessage("123", "first");
    await sender.sendMessage(123, "second");
    expect(attempts).toBe(3);
    expect(starts).toEqual([0, 1_000, 2_000]);
    expect(clock.now).toBe(2_000);
  });

  it.each([
    ["network", async (): Promise<Response> => { throw new Error("connection reset"); }],
    ["5xx", async (): Promise<Response> => Response.json({ ok: false }, { status: 503 })],
    ["malformed 429", async (): Promise<Response> =>
      Response.json({ ok: false, error_code: 429, parameters: { retry_after: "1" } }, { status: 429 })],
  ] as const)("does not retry %s failures", async (_kind: string, response: () => Promise<Response>) => {
    const apiFetch = vi.fn<typeof fetch>().mockImplementation(response);
    const sender = createTelegramSender({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      apiFetch,
      deliveryPolicy: createTelegramDeliveryPolicy({ minIntervalMs: 0 }),
    });
    await expect(sender.sendMessage(123, "message")).rejects.toThrow();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an unparsed HTTP error body", async () => {
    const cancel = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel },
    } as unknown as Response);
    const sender = createTelegramSender({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      apiFetch,
      deliveryPolicy: createTelegramDeliveryPolicy({ minIntervalMs: 0 }),
    });

    await expect(sender.sendMessage(123, "message")).rejects.toThrow("HTTP 503");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels response body reads when either composed sender signal aborts", async () => {
    const senderController = new AbortController();
    const callController = new AbortController();
    const cancel = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
    let resolveBody: ((payload: unknown) => void) | undefined;
    const response = {
      status: 200,
      ok: true,
      body: { cancel },
      json: async (): Promise<unknown> => new Promise<unknown>((resolve): void => { resolveBody = resolve; }),
    } as unknown as Response;
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
    const sender = createTelegramSender({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      apiFetch,
      signal: senderController.signal,
      deliveryPolicy: createTelegramDeliveryPolicy({ minIntervalMs: 0 }),
    });
    const pending = sender.sendMessage(123, "message", { signal: callController.signal });
    for (let attempt = 0; attempt < 8 && resolveBody === undefined; attempt += 1) {
      await Promise.resolve();
    }
    expect(resolveBody).toBeDefined();
    callController.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
    resolveBody?.({ ok: true, result: {} });

    const senderCancel = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
    let resolveSenderBody: ((payload: unknown) => void) | undefined;
    const senderResponse = {
      status: 200,
      ok: true,
      body: { cancel: senderCancel },
      json: async (): Promise<unknown> => new Promise<unknown>((resolve): void => {
        resolveSenderBody = resolve;
      }),
    } as unknown as Response;
    apiFetch.mockResolvedValueOnce(senderResponse);
    const senderPending = sender.sendMessage(123, "sender-level");
    for (let attempt = 0; attempt < 8 && resolveSenderBody === undefined; attempt += 1) {
      await Promise.resolve();
    }
    senderController.abort();
    await expect(senderPending).rejects.toMatchObject({ name: "AbortError" });
    expect(senderCancel).toHaveBeenCalledTimes(1);
    resolveSenderBody?.({ ok: true, result: {} });
  });
});

describe("grammY delivery transformer integration", () => {
  it("paces send/edit calls while leaving getMe and callback acknowledgements unthrottled", async () => {
    const clock = fakeClock();
    const calls: Array<{ method: string; at: number }> = [];
    const apiFetch = vi.fn<typeof fetch>().mockImplementation(async (input: string | URL | Request): Promise<Response> => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "unknown";
      calls.push({ method, at: clock.now });
      if (method === "getMe") return Response.json({ ok: true, result: testBotInfo });
      if (method === "answerCallbackQuery") return Response.json({ ok: true, result: true });
      if (method === "editMessageText") return Response.json({ ok: true, result: true });
      return Response.json({
        ok: true,
        result: { message_id: calls.length, date: 0, chat: { id: 123, type: "private" }, text: "ok" },
      });
    });
    const bot = createBot({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      allowedUserId: 123,
      statsService: testStatsService,
      logger: quietLogger,
      apiFetch,
      deliveryPolicy: createTelegramDeliveryPolicy({
        now: (): number => clock.now,
        sleep: async (delayMs: number): Promise<void> => { clock.now += delayMs; },
      }),
    });

    await bot.init();
    await bot.handleUpdate(ownerUpdate(1, "Rob Cross last 2 match averages"));
    expect(calls).toEqual([
      { method: "getMe", at: 0 },
      { method: "sendMessage", at: 0 },
      { method: "editMessageText", at: 1_000 },
    ]);

    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "callback-1",
        from: { id: 123, is_bot: false, first_name: "Owner" },
        chat_instance: "test-chat",
        data: "modus-player:0:10",
        message: {
          message_id: 10,
          date: 0,
          chat: { id: 123, type: "private", first_name: "Owner" },
          text: "Overview",
          reply_markup: {
            inline_keyboard: [[{ text: "Kevin Lane", callback_data: "modus-player:0:10" }]],
          },
        },
      },
    });
    expect(calls.slice(3)).toEqual([
      { method: "answerCallbackQuery", at: 1_000 },
      { method: "sendMessage", at: 2_000 },
      { method: "editMessageText", at: 3_000 },
    ]);
  });

  it("retries a validated grammY 429 response and does not retry malformed parameters", async () => {
    const clock = fakeClock();
    let sendAttempts = 0;
    const apiFetch = vi.fn<typeof fetch>().mockImplementation(async (input: string | URL | Request): Promise<Response> => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "unknown";
      if (method === "sendMessage") {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } });
        }
        return Response.json({
          ok: true,
          result: { message_id: 10, date: 0, chat: { id: 123, type: "private" }, text: "ok" },
        });
      }
      return Response.json({ ok: true, result: true });
    });
    const bot = createBot({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      allowedUserId: 123,
      statsService: testStatsService,
      logger: quietLogger,
      apiFetch,
      botInfo: testBotInfo,
      deliveryPolicy: createTelegramDeliveryPolicy({
        now: (): number => clock.now,
        sleep: async (delayMs: number): Promise<void> => { clock.now += delayMs; },
      }),
    });
    await bot.handleUpdate(ownerUpdate(1, "Rob Cross last 2 match averages"));
    expect(sendAttempts).toBe(2);
    expect(clock.now).toBe(2_000);
    expect(getTelegramRetryAfterFromResponse({
      ok: false,
      error_code: 429,
      parameters: { retry_after: "1" },
    })).toBeUndefined();
  });
});
