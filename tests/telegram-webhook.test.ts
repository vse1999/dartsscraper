import { describe, expect, it } from "vitest";

import {
  handleTelegramWebhook,
  readWebhookSecret,
  type WebhookDependencies,
} from "../api/telegram-webhook.js";
import type { Logger } from "../src/logger.js";
import type { Update } from "grammy/types";

const secret = "a".repeat(64);

const silentLogger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

interface WebhookHarness {
  readonly dependencies: WebhookDependencies;
  readonly updates: Update[];
}

function harness(processUpdate?: (update: Update) => Promise<void>): WebhookHarness {
  const updates: Update[] = [];
  return {
    updates,
    dependencies: {
      expectedSecret: secret,
      processUpdate: processUpdate ?? (async (update: Update): Promise<void> => { updates.push(update); }),
      logger: silentLogger,
    },
  };
}

function request(body: string, providedSecret = secret, extraHeaders: HeadersInit = {}): Request {
  return new Request("https://example.test/api/telegram-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": providedSecret,
      ...extraHeaders,
    },
    body,
  });
}

describe("Telegram webhook boundary", () => {
  it("accepts a valid authenticated update after processing completes", async () => {
    const state = harness();
    const response = await handleTelegramWebhook(request('{"update_id":123}'), state.dependencies);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.updates).toEqual([{ update_id: 123 }]);
  });

  it("hides the endpoint for wrong methods and secrets", async () => {
    const state = harness();
    const getResponse = await handleTelegramWebhook(
      new Request("https://example.test/api/telegram-webhook"),
      state.dependencies,
    );
    const wrongSecretResponse = await handleTelegramWebhook(
      request('{"update_id":1}', "b".repeat(64)),
      state.dependencies,
    );

    expect(getResponse.status).toBe(404);
    expect(wrongSecretResponse.status).toBe(404);
    expect(state.updates).toHaveLength(0);
  });

  it.each([
    ["not JSON", {}],
    ["{}", {}],
    ['{"update_id":-1}', {}],
    ['{"update_id":1}', { "content-length": "not-a-number" }],
    ['{"update_id":1}', { "content-length": String(65 * 1_024) }],
  ] as const)("rejects malformed or oversized authenticated input", async (body, headers) => {
    const state = harness();
    const response = await handleTelegramWebhook(request(body, secret, headers), state.dependencies);
    expect(response.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it("does not acknowledge Telegram before critical processing finishes", async () => {
    let resolveUpdate: (() => void) | undefined;
    const updateFinished = new Promise<void>((resolve: () => void): void => { resolveUpdate = resolve; });
    const state = harness(async (): Promise<void> => updateFinished);
    let responseSettled = false;

    const responsePromise = handleTelegramWebhook(request('{"update_id":7}'), state.dependencies);
    void responsePromise.then((): void => { responseSettled = true; });
    await Promise.resolve();
    expect(responseSettled).toBe(false);
    resolveUpdate?.();
    expect((await responsePromise).status).toBe(200);
  });

  it("returns a retryable error when update processing fails", async () => {
    const state = harness(async (): Promise<void> => { throw new Error("Telegram API unavailable"); });
    const response = await handleTelegramWebhook(request('{"update_id":8}'), state.dependencies);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("requires a high-entropy, Telegram-compatible secret", () => {
    expect(readWebhookSecret({ WEBHOOK_SECRET: secret })).toBe(secret);
    expect(() => readWebhookSecret({ WEBHOOK_SECRET: "too-short" })).toThrow("WEBHOOK_SECRET");
    expect(() => readWebhookSecret({ WEBHOOK_SECRET: `${"a".repeat(31)}!` })).toThrow("WEBHOOK_SECRET");
  });
});
