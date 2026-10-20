import { describe, expect, it, vi } from "vitest";

import type { Logger, LogContext } from "../src/logger.js";
import { createTelegramDeliveryPolicy } from "../src/telegram/delivery-policy.js";
import { createTelegramMessageEditor, createTelegramSender } from "../src/telegram/sender.js";

describe("Telegram message sender", () => {
  it("sends inline player keyboards through Telegram reply_markup", async () => {
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result: {} }));
    const sender = createTelegramSender({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      apiFetch,
      apiBaseUrl: "https://telegram.test",
    });

    await sender.sendMessage(123, "Overview", {
      replyMarkup: {
        inline_keyboard: [[{ text: "Kevin Lane", callback_data: "modus-player:0:10" }]],
      },
    });

    const requestInit = apiFetch.mock.calls[0]?.[1];
    const body: unknown = JSON.parse(String(requestInit?.body));
    expect(body).toEqual({
      chat_id: 123,
      text: "Overview",
      reply_markup: {
        inline_keyboard: [[{ text: "Kevin Lane", callback_data: "modus-player:0:10" }]],
      },
    });
  });

  it("edits background status messages through the narrow Telegram adapter", async () => {
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result: true }));
    const editor = createTelegramMessageEditor({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      apiFetch,
      apiBaseUrl: "https://telegram.test",
    });

    await editor.editMessageText(123, 77, "Verified 16 fixtures");

    expect(apiFetch).toHaveBeenCalledWith("https://telegram.test/bot123456:abcdefghijklmnopqrstuvwxyz_123456/editMessageText", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(apiFetch.mock.calls[0]?.[1]?.body)) as unknown).toEqual({ chat_id: 123, message_id: 77, text: "Verified 16 fixtures" });
  });

  it("rejects invalid status IDs and Telegram edit failures without retrying", async () => {
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("failure", { status: 503 }));
    const editor = createTelegramMessageEditor({ token: "123456:abcdefghijklmnopqrstuvwxyz_123456", apiFetch, apiBaseUrl: "https://telegram.test" });

    await expect(editor.editMessageText(123, 0, "status")).rejects.toThrow("message ID");
    await expect(editor.editMessageText(123, 77, "status")).rejects.toThrow("HTTP 503");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("records Telegram rate limits as structured, secret-free operational events", async () => {
    const entries = createLogEntries();
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { ok: false, error_code: 429, parameters: { retry_after: 2 } },
      { status: 429 },
    ));
    const sender = createTelegramSender({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      apiFetch,
      apiBaseUrl: "https://telegram.test",
      deliveryPolicy: createTelegramDeliveryPolicy({ minIntervalMs: 0, maxRetries: 0 }),
      logger: entries.logger,
    });

    await expect(sender.sendMessage(123, "private report text")).rejects.toThrow("retry after 2 seconds");

    expect(entries.records).toContainEqual(expect.objectContaining({
      level: "info",
      context: expect.objectContaining({
        event: "telegram_http_response",
        operation: "sendMessage",
        status: 429,
        outcome: "rate_limited",
        retryAfterSeconds: 2,
      }),
    }));
    const serialized = JSON.stringify(entries.records);
    expect(serialized).not.toContain("123456:abcdefghijklmnopqrstuvwxyz_123456");
    expect(serialized).not.toContain("private report text");
  });

  it("records a missing HTTP response as unknown without logging the error message", async () => {
    const entries = createLogEntries();
    const apiFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("private transport details"));
    const sender = createTelegramSender({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      apiFetch,
      apiBaseUrl: "https://telegram.test",
      logger: entries.logger,
    });

    await expect(sender.sendMessage(123, "private report text")).rejects.toThrow("request failed");

    expect(entries.records).toContainEqual(expect.objectContaining({
      level: "warn",
      context: expect.objectContaining({
        event: "telegram_delivery_unknown",
        operation: "sendMessage",
        outcome: "unknown",
        errorType: "Error",
      }),
    }));
    const serialized = JSON.stringify(entries.records);
    expect(serialized).not.toContain("123456:abcdefghijklmnopqrstuvwxyz_123456");
    expect(serialized).not.toContain("private report text");
    expect(serialized).not.toContain("private transport details");
  });
});

interface LogRecord {
  readonly level: "info" | "warn";
  readonly context?: LogContext;
}

function createLogEntries(): { readonly logger: Logger; readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger: Logger = {
    debug: (_message: string, _context?: LogContext): void => undefined,
    info: (_message: string, context?: LogContext): void => {
      records.push({ level: "info", ...(context === undefined ? {} : { context }) });
    },
    warn: (_message: string, context?: LogContext): void => {
      records.push({ level: "warn", ...(context === undefined ? {} : { context }) });
    },
    error: (_message: string, _context?: LogContext): void => undefined,
  };
  return { logger, records };
}
