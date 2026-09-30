import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logger.js";
import type { OddsMatch, OddsReader, OddsReport } from "../src/odds/contracts.js";
import { createBot, createConfiguredBot, type BotEnvironment } from "../src/telegram/bot.js";
import {
  handleOddsCommand,
  parseOddsCommand,
  type OddsAcknowledgement,
  type OddsCommandResponder,
} from "../src/telegram/odds-command.js";
import { formatOddsMessages } from "../src/telegram/odds-formatter.js";
import type { Update, UserFromGetMe } from "grammy/types";

const { createDefaultOddsReaderMock } = vi.hoisted(() => ({
  createDefaultOddsReaderMock: vi.fn((): OddsReader => ({
    getOdds: async (): Promise<OddsReport> => ({
      source: "eredmenyek",
      sourceUrl: "https://www.eredmenyek.com/darts/",
      observedAt: "2026-09-28T16:00:00.000Z",
      date: "2026-09-28",
      timeZone: "Europe/Budapest",
      matches: [],
      warnings: [],
    }),
  })),
}));

vi.mock("../src/odds/default.js", () => ({
  createDefaultOddsReader: createDefaultOddsReaderMock,
}));

const logger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function report(overrides: Partial<OddsReport> = {}): OddsReport {
  return {
    source: "eredmenyek",
    sourceUrl: "https://www.eredmenyek.com/darts/",
    observedAt: "2026-09-28T16:00:00.000Z",
    date: "2026-09-28",
    timeZone: "Europe/Budapest",
    matches: [{
      eventId: "event-1",
      competition: "World Grand Prix",
      player1: "Player One",
      player2: "Player Two",
      odds1: 1.72,
      odds2: 2.15,
      bookmaker: "TippmixPro",
      scheduledTime: "18:00",
      sourceUrl: "https://www.eredmenyek.com/match/event-1/",
    }],
    warnings: [],
    ...overrides,
  };
}

function responder(
  replies: string[],
  edits: Array<{ readonly messageId: number; readonly text: string }>,
): OddsCommandResponder {
  return {
    reply: async (text: string): Promise<OddsAcknowledgement> => {
      replies.push(text);
      return { messageId: replies.length };
    },
    edit: async (messageId: number, text: string): Promise<void> => {
      edits.push({ messageId, text });
    },
  };
}

function testBotInfo(): UserFromGetMe {
  return {
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
}

function oddsUpdate(
  updateId: number,
  userId: number,
  chatType: "private" | "group" | "supergroup",
  text: string,
): Update {
  const chat = chatType === "private"
    ? { id: userId, type: "private" as const, first_name: "Test User" }
    : chatType === "group"
      ? { id: userId, type: "group" as const, title: "Darts" }
      : { id: userId, type: "supergroup" as const, title: "Darts" };
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      from: { id: userId, is_bot: false, first_name: "Test User" },
      chat,
      text,
      entities: [{ offset: 0, length: text.split(/\s/gu)[0]?.length ?? 0, type: "bot_command" }],
    },
  };
}

describe("Telegram odds command", () => {
  it("fails closed for missing, invalid, and explicitly false flags without constructing a reader", () => {
    const base: BotEnvironment = {
      BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      ALLOWED_USER_ID: "123",
    };
    createDefaultOddsReaderMock.mockClear();

    createConfiguredBot(base, logger);
    createConfiguredBot({ ...base, ODDS_FETCH_ENABLED: "maybe" }, logger);
    createConfiguredBot({ ...base, ODDS_FETCH_ENABLED: "false" }, logger);
    expect(createDefaultOddsReaderMock).not.toHaveBeenCalled();
  });

  it("constructs the lazy reader only for an explicit true flag", () => {
    const environment: BotEnvironment = {
      BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      ALLOWED_USER_ID: "123",
      ODDS_FETCH_ENABLED: "true",
      ODDS_BROWSER_EXECUTABLE_PATH: "C:/browser/chrome.exe",
    };
    createDefaultOddsReaderMock.mockClear();

    const bot = createConfiguredBot(environment, logger);

    expect(bot).toBeDefined();
    expect(createDefaultOddsReaderMock).toHaveBeenCalledOnce();
    expect(createDefaultOddsReaderMock).toHaveBeenCalledWith({ executablePath: "C:/browser/chrome.exe" });
  });

  it("accepts only today/tomorrow and defaults to today", () => {
    expect(parseOddsCommand("/odds")).toBe("today");
    expect(parseOddsCommand("/odds today")).toBe("today");
    expect(parseOddsCommand("/odds@darts_bot tomorrow")).toBe("tomorrow");
    expect(parseOddsCommand("/odds https://example.test")).toBeNull();
    expect(parseOddsCommand("/odds next-week")).toBeNull();
  });

  it("renders an empty result distinctly and keeps the source observation", () => {
    const messages = formatOddsMessages(report({ matches: [], warnings: ["One provider row was skipped."] }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("No eligible scheduled TippmixPro match-winner odds");
    expect(messages[0]).toContain("successful empty result");
    expect(messages[0]).toContain("2026-09-28T16:00:00.000Z");
    expect(messages[0]).toContain("Europe/Budapest");
  });

  it("paginates a successful result without exceeding Telegram's limit", async () => {
    const template: OddsMatch = {
      eventId: "template",
      competition: "World Grand Prix",
      player1: "Player One",
      player2: "Player Two",
      odds1: 1.72,
      odds2: 2.15,
      bookmaker: "TippmixPro",
      scheduledTime: "18:00",
      sourceUrl: "https://www.eredmenyek.com/match/template/",
    };
    const matches: OddsMatch[] = Array.from({ length: 24 }, (_value: unknown, index: number) => ({
      ...template,
      eventId: `event-${index}`,
      player1: `Player One ${index} ${"X".repeat(100)}`,
      player2: `Player Two ${index} ${"Y".repeat(100)}`,
    }));
    const reader: OddsReader = { getOdds: vi.fn(async (): Promise<OddsReport> => report({ matches })) };
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    const outcome = await handleOddsCommand("/odds tomorrow", reader, responder(replies, edits), logger);

    expect(outcome).toBe("success");
    expect(reader.getOdds).toHaveBeenCalledWith("tomorrow", expect.any(AbortSignal));
    expect(edits[0]?.text.length).toBeLessThanOrEqual(4_096);
    expect(replies.every((text): boolean => text.length <= 4_096)).toBe(true);
    expect(edits.length + replies.length).toBeGreaterThan(2);
  });

  it("does not overwrite a delivered first page after an uncertain later delivery", async () => {
    const template: OddsMatch = {
      eventId: "template",
      competition: "World Grand Prix",
      player1: "Player One",
      player2: "Player Two",
      odds1: 1.72,
      odds2: 2.15,
      bookmaker: "TippmixPro",
      scheduledTime: "18:00",
      sourceUrl: "https://www.eredmenyek.com/match/template/",
    };
    const matches: OddsMatch[] = Array.from({ length: 24 }, (_value: unknown, index: number) => ({
      ...template,
      eventId: `event-${index}`,
      player1: `Player One ${index} ${"X".repeat(100)}`,
      player2: `Player Two ${index} ${"Y".repeat(100)}`,
    }));
    const replies: string[] = [];
    const edits: string[] = [];
    const logMessages: string[] = [];
    const deliveryLogger: Logger = {
      debug: (message: string): void => { logMessages.push(message); },
      info: (message: string): void => { logMessages.push(message); },
      warn: (message: string): void => { logMessages.push(message); },
      error: (message: string): void => { logMessages.push(message); },
    };
    const outcome = await handleOddsCommand(
      "/odds",
      { getOdds: async (): Promise<OddsReport> => report({ matches }) },
      {
        reply: async (text: string): Promise<OddsAcknowledgement> => {
          replies.push(text);
          if (replies.length > 1) throw new Error("uncertain Telegram result");
          return { messageId: 11 };
        },
        edit: async (_messageId: number, text: string): Promise<void> => { edits.push(text); },
      },
      deliveryLogger,
    );

    expect(outcome).toBe("failed");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("Player One 0");
    expect(edits[0]).not.toContain("could not be completed");
    expect(replies).toHaveLength(2);
    expect(logMessages).not.toContain("Odds lookup completed.");
    expect(logMessages).not.toContain("Report lifecycle completed.");
  });

  it("does not research when disabled or acknowledgement delivery fails", async () => {
    const research = vi.fn(async (): Promise<OddsReport> => report());
    const reader: OddsReader = { getOdds: research };
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    const disabled = await handleOddsCommand("/odds", undefined, responder(replies, edits), logger);
    expect(disabled).toBe("unavailable");
    expect(research).not.toHaveBeenCalled();

    const ackFails: OddsCommandResponder = {
      reply: async (): Promise<OddsAcknowledgement> => { throw new Error("Telegram unavailable"); },
      edit: async (): Promise<void> => undefined,
    };
    const failed = await handleOddsCommand("/odds", reader, ackFails, logger);
    expect(failed).toBe("failed");
    expect(research).not.toHaveBeenCalled();
  });

  it("rejects malformed arguments before the reader can be called", async () => {
    const research = vi.fn(async (): Promise<OddsReport> => report());
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];

    const outcome = await handleOddsCommand(
      "/odds https://example.test/today",
      { getOdds: research },
      responder(replies, edits),
      logger,
    );

    expect(outcome).toBe("invalid");
    expect(research).not.toHaveBeenCalled();
    expect(replies[0]).toContain("Use /odds today or /odds tomorrow");
  });

  it("aborts an in-flight source read at the research deadline and reports a timeout", async () => {
    let aborted = false;
    const reader: OddsReader = {
      getOdds: async (_day, signal): Promise<OddsReport> => new Promise<OddsReport>((_resolve, reject): void => {
        signal?.addEventListener("abort", (): void => {
          aborted = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
      }),
    };
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];

    const outcome = await handleOddsCommand(
      "/odds",
      reader,
      responder(replies, edits),
      logger,
      undefined,
      { totalMs: 200, researchMs: 10 },
    );

    expect(outcome).toBe("failed");
    expect(aborted).toBe(true);
    expect(edits[0]?.text).toContain("timed out");
    expect(replies).toHaveLength(1);
  });

  it("authorizes odds only for the owner private chat and delivers the mocked report", async () => {
    const apiMethods: string[] = [];
    const requestBodies: string[] = [];
    const apiFetch: typeof fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "unknown";
      apiMethods.push(method);
      if (typeof init?.body === "string") requestBodies.push(init.body);
      return Response.json({
        ok: true,
        result: {
          message_id: apiMethods.length,
          date: 0,
          chat: { id: 123, type: "private" },
          text: "ok",
        },
      });
    };
    const getOdds = vi.fn(async (): Promise<OddsReport> => report());
    const bot = createBot({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      allowedUserId: 123,
      statsService: { getPlayerStats: async (): Promise<never> => { throw new Error("not used"); } },
      oddsReader: { getOdds },
      logger,
      apiFetch,
      botInfo: testBotInfo(),
    });

    await bot.handleUpdate(oddsUpdate(1, 999, "private", "/odds"));
    await bot.handleUpdate(oddsUpdate(2, 123, "supergroup", "/odds"));
    expect(getOdds).not.toHaveBeenCalled();
    expect(apiMethods).toEqual([]);

    await bot.handleUpdate(oddsUpdate(3, 123, "private", "/odds today"));
    expect(getOdds).toHaveBeenCalledOnce();
    expect(apiMethods).toEqual(["sendMessage", "editMessageText"]);
    expect(requestBodies.join("\n")).toContain("Player One");
    expect(requestBodies.join("\n")).toContain("1.72");
  });

  it("does not research after scheduler rejection and edits the acknowledgement", async () => {
    const research = vi.fn(async (): Promise<OddsReport> => report());
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    const outcome = await handleOddsCommand(
      "/odds",
      { getOdds: research },
      responder(replies, edits),
      logger,
      (): never => { throw new Error("scheduler unavailable"); },
    );
    expect(outcome).toBe("failed");
    expect(research).not.toHaveBeenCalled();
    expect(edits[0]?.text).toContain("could not be scheduled");
  });

  it("runs a scheduled lookup and keeps provider errors out of Telegram", async () => {
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    let task: Promise<void> | undefined;
    const outcome = await handleOddsCommand(
      "/odds",
      { getOdds: async (): Promise<OddsReport> => { throw new Error("secret browser HTML"); } },
      responder(replies, edits),
      logger,
      (scheduled: Promise<void>): void => { task = scheduled; },
    );
    expect(outcome).toBe("success");
    expect(task).toBeDefined();
    await task;
    expect(edits.at(-1)?.text).toContain("could not be completed");
    expect(edits.map((entry): string => entry.text).join("\n")).not.toContain("secret browser HTML");
  });
});
