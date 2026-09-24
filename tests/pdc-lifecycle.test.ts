import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logger.js";
import type { Update, UserFromGetMe } from "grammy/types";
import {
  handlePdcReportCommand,
  type PdcAcknowledgement,
  type PdcCommandResponder,
  type PdcTournamentReader,
} from "../src/telegram/pdc-command.js";
import { createBot } from "../src/telegram/bot.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../src/telegram/stats-service.js";
import type { PdcUpcomingReport } from "../src/pdc/service.js";

const logger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const emptyUpcomingReport: PdcUpcomingReport = {
  date: "2026-09-17",
  fixtures: [],
  players: [],
};

function reader(overrides: Partial<PdcTournamentReader> = {}): PdcTournamentReader {
  return {
    getUpcomingReportForDate: async (): Promise<PdcUpcomingReport> => emptyUpcomingReport,
    getLatestResults: async (): Promise<readonly never[]> => [],
    ...overrides,
  };
}

function responder(
  reply: PdcCommandResponder["reply"],
  edit?: PdcCommandResponder["edit"],
): PdcCommandResponder {
  return edit === undefined ? { reply } : { reply, edit };
}

describe("PDC report lifecycle", () => {
  it("does not research when acknowledgement delivery fails", async () => {
    const research = vi.fn(async (): Promise<PdcUpcomingReport> => emptyUpcomingReport);
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader({ getUpcomingReportForDate: research }),
      (): string => "2026-09-17",
      responder(async (): Promise<void> => { throw new Error("ack failed"); }),
      logger,
    );

    expect(outcome).toBe("failed");
    expect(research).not.toHaveBeenCalled();
  });

  it("does not research after scheduler registration rejects", async () => {
    const research = vi.fn(async (): Promise<PdcUpcomingReport> => emptyUpcomingReport);
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader({ getUpcomingReportForDate: research }),
      (): string => "2026-09-17",
      responder(async (): Promise<PdcAcknowledgement> => ({ messageId: 7 })),
      logger,
      (): never => { throw new Error("scheduler unavailable"); },
    );

    expect(outcome).toBe("failed");
    expect(research).not.toHaveBeenCalled();
  });

  it("does not send a replacement when the acknowledgement cannot be edited", async () => {
    const replies: string[] = [];
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader(),
      (): string => "2026-09-17",
      responder(async (text: string): Promise<void> => { replies.push(text); }),
      logger,
      (): never => { throw new Error("scheduler unavailable"); },
    );

    expect(outcome).toBe("failed");
    expect(replies).toHaveLength(1);
  });

  it("edits the confirmed acknowledgement exactly once on scheduling failure", async () => {
    const edits: Array<{ readonly id: number; readonly text: string }> = [];
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader(),
      (): string => "2026-09-17",
      responder(
        async (): Promise<PdcAcknowledgement> => ({ messageId: 19 }),
        async (id: number, text: string): Promise<void> => { edits.push({ id, text }); },
      ),
      logger,
      (): never => { throw new Error("scheduler unavailable"); },
    );

    expect(outcome).toBe("failed");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      id: 19,
      text: expect.stringContaining("could not be scheduled"),
    });
  });

  it("does not send a replacement when scheduling-failure acknowledgement editing rejects", async () => {
    const replies: string[] = [];
    let editAttempts = 0;
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader(),
      (): string => "2026-09-17",
      responder(
        async (text: string): Promise<PdcAcknowledgement> => {
          replies.push(text);
          return { messageId: 21 };
        },
        async (): Promise<void> => {
          editAttempts += 1;
          throw new Error("edit rejected");
        },
      ),
      logger,
      (): never => { throw new Error("scheduler unavailable"); },
    );

    expect(outcome).toBe("failed");
    expect(editAttempts).toBe(1);
    expect(replies).toHaveLength(1);
  });

  it("bounds a hanging scheduling-failure edit at the total deadline", async () => {
    const replies: string[] = [];
    let editAttempts = 0;
    const hangingEdit = new Promise<void>(() => undefined);
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader(),
      (): string => "2026-09-17",
      responder(
        async (text: string): Promise<PdcAcknowledgement> => {
          replies.push(text);
          return { messageId: 22 };
        },
        async (): Promise<void> => {
          editAttempts += 1;
          await hangingEdit;
        },
      ),
      logger,
      (): never => { throw new Error("scheduler unavailable"); },
      { totalMs: 10, researchMs: 5 },
    );

    expect(outcome).toBe("failed");
    expect(editAttempts).toBe(1);
    expect(replies).toHaveLength(1);
  });

  it("skips scheduling-failure editing after an injected total deadline", async () => {
    let expired = false;
    let editAttempts = 0;
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader(),
      (): string => "2026-09-17",
      responder(async (): Promise<PdcAcknowledgement> => {
        expired = true;
        return { messageId: 23 };
      }, async (): Promise<void> => {
        editAttempts += 1;
      }),
      logger,
      (): never => { throw new Error("scheduler unavailable"); },
      {
        totalMs: 50,
        researchMs: 10,
        now: (): number => expired ? 51 : 0,
      },
    );

    expect(outcome).toBe("failed");
    expect(editAttempts).toBe(0);
  });

  it("stops after an uncertain report page instead of sending an error reply", async () => {
    const replies: string[] = [];
    const warnings: string[] = [];
    const outcome = await handlePdcReportCommand(
      "/pdc latest",
      reader({ getLatestResults: async (): Promise<readonly never[]> => [] }),
      (): string => "2026-09-17",
      responder(async (text: string): Promise<void> => {
        replies.push(text);
        if (replies.length === 2) throw new Error("uncertain Telegram result");
      }),
      {
        ...logger,
        warn: (message: string): void => { warnings.push(message); },
      },
    );

    expect(outcome).toBe("failed");
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain("PDC LATEST");
    expect(replies.join("\n")).not.toContain("could not be completed");
    expect(warnings).toContain("PDC tournament report failed.");
  });

  it("delivers the last partial snapshot when research expires", async () => {
    const replies: string[] = [];
    let resolveResearch: ((report: PdcUpcomingReport) => void) | undefined;
    const pending = new Promise<PdcUpcomingReport>((resolve): void => { resolveResearch = resolve; });
    const outcomePromise = handlePdcReportCommand(
      "/pdc tomorrow",
      reader({
        getUpcomingReportForDate: async (
          _date: string,
          _signal: AbortSignal | undefined,
          onPartial?: (report: PdcUpcomingReport) => void,
        ): Promise<PdcUpcomingReport> => {
          onPartial?.(emptyUpcomingReport);
          return pending;
        },
      }),
      (): string => "2026-09-17",
      responder(async (text: string): Promise<void> => { replies.push(text); }),
      logger,
      undefined,
      { totalMs: 100, researchMs: 5 },
    );

    const outcome = await outcomePromise;
    expect(outcome).toBe("failed");
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain("No scheduled PDC match was found");
    resolveResearch?.(emptyUpcomingReport);
  });

  it("keeps latest reports in the foreground even when a scheduler is supplied", async () => {
    const schedule = vi.fn((_task: Promise<void>): void => undefined);
    const latest = vi.fn(async (): Promise<readonly never[]> => []);
    const outcome = await handlePdcReportCommand(
      "/pdc latest",
      reader({ getLatestResults: latest }),
      (): string => "2026-09-17",
      responder(async (): Promise<void> => undefined),
      logger,
      schedule,
    );

    expect(outcome).toBe("success");
    expect(latest).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("honors an injected clock when research admission has expired", async () => {
    let expired = false;
    const research = vi.fn(async (): Promise<PdcUpcomingReport> => emptyUpcomingReport);
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader({ getUpcomingReportForDate: research }),
      (): string => "2026-09-17",
      responder(async (): Promise<void> => { expired = true; }),
      logger,
      undefined,
      {
        totalMs: 50,
        researchMs: 10,
        now: (): number => expired ? 11 : 0,
      },
    );

    expect(outcome).toBe("failed");
    expect(research).not.toHaveBeenCalled();
  });

  it("wires the production responder to edit the confirmed Telegram acknowledgement", async () => {
    const apiMethods: string[] = [];
    const requestBodies: string[] = [];
    const requestSignals: Array<AbortSignal | undefined> = [];
    const apiFetch: typeof fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      apiMethods.push(new URL(String(input)).pathname.split("/").at(-1) ?? "unknown");
      requestSignals.push(init?.signal ?? undefined);
      if (typeof init?.body === "string") requestBodies.push(init.body);
      return Response.json({
        ok: true,
        result: {
          message_id: 91,
          date: 0,
          chat: { id: 123, type: "private" },
          text: "test response",
        },
      });
    };
    const research = vi.fn(async (): Promise<PdcUpcomingReport> => emptyUpcomingReport);
    const service: PdcTournamentReader = {
      getUpcomingReportForDate: research,
      getLatestResults: async (): Promise<readonly never[]> => [],
    };
    const statsService: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => {
        throw new Error("PDC test must not call player statistics");
      },
    };
    const botInfo: UserFromGetMe = {
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
    const bot = createBot({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      allowedUserId: 123,
      statsService,
      pdcTournamentService: service,
      logger,
      apiFetch,
      botInfo,
      scheduleBackgroundTask: (): never => { throw new Error("scheduler unavailable"); },
    });
    const update: Update = {
      update_id: 44,
      message: {
        message_id: 45,
        date: 0,
        from: { id: 123, is_bot: false, first_name: "Owner" },
        chat: { id: 123, type: "private", first_name: "Owner" },
        text: "/pdc tomorrow",
        entities: [{ offset: 0, length: 4, type: "bot_command" }],
      },
    };

    await bot.handleUpdate(update);

    expect(apiMethods).toEqual(["sendMessage", "editMessageText"]);
    expect(requestBodies[1]).toContain('"message_id":91');
    expect(requestSignals).toHaveLength(2);
    expect(requestSignals.every((signal): boolean => signal !== undefined)).toBe(true);
    expect(research).not.toHaveBeenCalled();
  });
});
