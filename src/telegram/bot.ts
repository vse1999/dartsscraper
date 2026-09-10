import { Bot, type BotConfig, type Context, type NextFunction } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import {
  DartsOrakelRequestError,
  DartsOrakelStructureChangedError,
  InsufficientMatchDataError,
  ModusHistoryUnavailableError,
  PlayerAmbiguousError,
  PlayerNotFoundError,
} from "../errors.js";
import { ConsoleLogger, type Logger } from "../logger.js";
import { isOwnerPrivateChat, parseAllowedUserId } from "./authorization.js";
import { formatPlayerStats } from "./formatter.js";
import {
  handleModusReportCommand,
  type BackgroundTaskScheduler,
  type ModusReportTrigger,
} from "./modus-command.js";
import { createHttpModusReportTrigger } from "./modus-trigger.js";
import {
  MODUS_PLAYER_CALLBACK_PATTERN,
  resolveModusPlayerCallback,
} from "./modus-player-callback.js";
import { parseStatsQuery, statsQueryUsage, type StatsQuery } from "./query.js";
import { createDefaultPlayerStatsService, type PlayerStatsReader } from "./stats-service.js";

const STATUS_MESSAGE = "Looking up completed matches…";
export const TELEGRAM_BOT_RELEASE = "modus-dashboard-v5";

export interface BotEnvironment {
  readonly BOT_TOKEN?: string;
  readonly ALLOWED_USER_ID?: string;
  readonly CRON_SECRET?: string;
  readonly MODUS_REPORT_URL?: string;
  readonly VERCEL_PROJECT_PRODUCTION_URL?: string;
}

export interface CreateBotOptions {
  readonly token: string;
  readonly allowedUserId: number;
  readonly statsService: PlayerStatsReader;
  readonly logger?: Logger;
  readonly apiFetch?: typeof fetch;
  readonly botInfo?: UserFromGetMe;
  readonly modusReportTrigger?: ModusReportTrigger;
  readonly scheduleBackgroundTask?: BackgroundTaskScheduler;
}

export interface StatsMessageResponder {
  reply(text: string): Promise<{ readonly messageId: number }>;
  edit(messageId: number, text: string): Promise<void>;
}

export type StatsHandlerOutcome =
  | "invalid-query"
  | "success"
  | "player-not-found"
  | "player-ambiguous"
  | "no-matches"
  | "upstream-timeout"
  | "upstream-unavailable"
  | "internal-error";

export function readBotConfiguration(environment: BotEnvironment): {
  readonly token: string;
  readonly allowedUserId: number;
} {
  const token = environment.BOT_TOKEN?.trim();
  if (token === undefined || !/^\d{5,20}:[A-Za-z0-9_-]{20,}$/u.test(token)) {
    throw new Error("BOT_TOKEN must use the token format issued by Telegram BotFather.");
  }
  return {
    token,
    allowedUserId: parseAllowedUserId(environment.ALLOWED_USER_ID),
  };
}

export function createBot(options: CreateBotOptions): Bot<Context> {
  const logger = options.logger ?? new ConsoleLogger({ minimumLevel: "info" });
  const botConfig: BotConfig<Context> = {
    client: options.apiFetch === undefined
      ? { timeoutSeconds: 10 }
      : { timeoutSeconds: 10, fetch: options.apiFetch },
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
  };
  const bot = new Bot<Context>(options.token, botConfig);

  bot.catch((error): void => {
    logger.error("Telegram update escaped handler error handling.", {
      updateId: error.ctx.update.update_id,
      code: "UNHANDLED_BOT_ERROR",
    });
  });

  // This guard is intentionally first so unauthorized updates cannot reach a
  // command, a reply, or the external statistics provider.
  bot.use(async (ctx: Context, next: NextFunction): Promise<void> => {
    if (!isOwnerPrivateChat(ctx.from?.id, ctx.chat?.type, options.allowedUserId)) {
      return;
    }
    await next();
  });

  bot.command("start", async (ctx: Context): Promise<void> => {
    await ctx.reply(`Private darts statistics bot ready.\n\n${botHelpText()}`);
  });

  bot.command("help", async (ctx: Context): Promise<void> => {
    await ctx.reply(botHelpText());
  });

  bot.command("health", async (ctx: Context): Promise<void> => {
    await ctx.reply(`Bot online. Telegram delivery is working.\nRelease: ${TELEGRAM_BOT_RELEASE}`);
  });

  bot.command("modus", async (ctx: Context): Promise<void> => {
    await handleModusReportCommand(
      ctx.message?.text ?? "",
      options.modusReportTrigger,
      { reply: async (text: string): Promise<void> => { await ctx.reply(text); } },
      logger,
      options.scheduleBackgroundTask,
    );
  });

  bot.callbackQuery(MODUS_PLAYER_CALLBACK_PATTERN, async (ctx): Promise<void> => {
    const message = ctx.callbackQuery.message;
    const replyMarkup = message !== undefined && "reply_markup" in message
      ? message.reply_markup
      : undefined;
    const query = resolveModusPlayerCallback(ctx.callbackQuery.data, replyMarkup);
    if (query === null) {
      await ctx.answerCallbackQuery({
        text: "This player button is no longer valid. Run /modus again.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Loading ${query.playerName}…` });
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const responder: StatsMessageResponder = {
      reply: async (text: string): Promise<{ readonly messageId: number }> => {
        const sent = await ctx.reply(text);
        return { messageId: sent.message_id };
      },
      edit: async (messageId: number, text: string): Promise<void> => {
        await ctx.api.editMessageText(chatId, messageId, text);
      },
    };
    await handleStatsQuery(query, options.statsService, responder, logger, ctx.update.update_id);
  });

  bot.on("message:text", async (ctx: Context): Promise<void> => {
    const text = ctx.message?.text;
    const chatId = ctx.chat?.id;
    if (text === undefined || text.startsWith("/") || chatId === undefined) return;

    const responder: StatsMessageResponder = {
      reply: async (message: string): Promise<{ readonly messageId: number }> => {
        const sent = await ctx.reply(message);
        return { messageId: sent.message_id };
      },
      edit: async (messageId: number, message: string): Promise<void> => {
        await ctx.api.editMessageText(chatId, messageId, message);
      },
    };
    await handleStatsText(text, options.statsService, responder, logger, ctx.update.update_id);
  });

  return bot;
}

export function createConfiguredBot(
  environment: BotEnvironment = process.env,
  logger: Logger = new ConsoleLogger({ minimumLevel: "info" }),
  scheduleBackgroundTask?: BackgroundTaskScheduler,
): Bot<Context> {
  const configuration = readBotConfiguration(environment);
  const modusReportTrigger = createConfiguredModusReportTrigger(environment);
  return createBot({
    ...configuration,
    statsService: createDefaultPlayerStatsService(logger),
    ...(modusReportTrigger === undefined
      ? {}
      : { modusReportTrigger }),
    ...(scheduleBackgroundTask === undefined ? {} : { scheduleBackgroundTask }),
    logger,
  });
}

function createConfiguredModusReportTrigger(environment: BotEnvironment): ModusReportTrigger | undefined {
  const cronSecret = environment.CRON_SECRET?.trim();
  const endpointUrl = resolveModusReportEndpointUrl(environment);
  if (cronSecret === undefined || cronSecret === "" || endpointUrl === undefined || endpointUrl === "") return undefined;
  return createHttpModusReportTrigger({ endpointUrl, cronSecret });
}

export function resolveModusReportEndpointUrl(environment: BotEnvironment): string | undefined {
  const configuredUrl = environment.MODUS_REPORT_URL?.trim();
  if (configuredUrl !== undefined && configuredUrl !== "") return configuredUrl;
  const productionHost = environment.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return productionHost === undefined || productionHost === ""
    ? undefined
    : `https://${productionHost}/api/daily-modus-report`;
}

export async function handleStatsText(
  text: string,
  statsService: PlayerStatsReader,
  responder: StatsMessageResponder,
  logger: Logger,
  updateId: number,
): Promise<StatsHandlerOutcome> {
  const query = parseStatsQuery(text);
  if (query === null) {
    logger.info("Telegram statistics query rejected.", {
      updateId,
      code: "INVALID_QUERY",
      release: TELEGRAM_BOT_RELEASE,
    });
    await responder.reply(`I could not understand that request.\n\n${botHelpText()}`);
    return "invalid-query";
  }

  return handleStatsQuery(query, statsService, responder, logger, updateId);
}

async function handleStatsQuery(
  query: StatsQuery,
  statsService: PlayerStatsReader,
  responder: StatsMessageResponder,
  logger: Logger,
  updateId: number,
): Promise<Exclude<StatsHandlerOutcome, "invalid-query">> {
  const startedAt = Date.now();
  const status = await responder.reply(STATUS_MESSAGE);
  let outcome: Exclude<StatsHandlerOutcome, "invalid-query">;
  let finalMessage: string;
  let returnedCount: number | undefined;
  let provider: string | undefined;
  try {
    const result = await statsService.getPlayerStats(query.playerName, query.matchCount, query.source);
    finalMessage = formatPlayerStats(result);
    returnedCount = result.matches.length;
    provider = result.provider;
    outcome = "success";
  } catch (error: unknown) {
    const failure = publicFailure(error);
    finalMessage = failure.message;
    outcome = failure.outcome;
    logger.warn("Player statistics lookup failed.", {
      updateId,
      durationMs: Date.now() - startedAt,
      code: failure.outcome,
      ...(error instanceof DartsOrakelRequestError && error.status !== undefined
        ? { upstreamStatus: error.status }
        : {}),
    });
  }

  try {
    await responder.edit(status.messageId, finalMessage);
  } catch {
    logger.warn("Telegram status message could not be edited; using a new message.", {
      updateId,
      code: "TELEGRAM_EDIT_FAILED",
    });
    try {
      await responder.reply(finalMessage);
    } catch {
      logger.error("Telegram final response could not be delivered.", {
        updateId,
        code: "TELEGRAM_SEND_FAILED",
      });
      throw new Error("Telegram final response delivery failed.");
    }
  }

  if (outcome === "success") {
    logger.info("Player statistics lookup completed.", {
      updateId,
      durationMs: Date.now() - startedAt,
      requestedCount: query.matchCount,
      returnedCount,
      provider,
      requestedSource: query.source,
    });
  }
  return outcome;
}

function botHelpText(): string {
  return `${statsQueryUsage()}\n\nManual MODUS reports:\n/modus today\n/modus tomorrow\n\nRelease: ${TELEGRAM_BOT_RELEASE}`;
}

function publicFailure(error: unknown): {
  readonly outcome: Exclude<StatsHandlerOutcome, "invalid-query" | "success">;
  readonly message: string;
} {
  if (error instanceof PlayerNotFoundError) {
    return { outcome: "player-not-found", message: "Player not found. Check the exact full name and try again." };
  }
  if (error instanceof PlayerAmbiguousError) {
    return { outcome: "player-ambiguous", message: "That player name is ambiguous. Send the exact full name." };
  }
  if (error instanceof InsufficientMatchDataError) {
    return { outcome: "no-matches", message: "No completed matches were found for that player." };
  }
  if (error instanceof DartsOrakelRequestError) {
    return error.status === undefined || error.status === 408
      ? { outcome: "upstream-timeout", message: "The statistics lookup timed out. Please try again." }
      : { outcome: "upstream-unavailable", message: "The statistics source is temporarily unavailable. Please try again later." };
  }
  if (error instanceof DartsOrakelStructureChangedError) {
    return { outcome: "upstream-unavailable", message: "The statistics source is temporarily unavailable. Please try again later." };
  }
  if (error instanceof ModusHistoryUnavailableError) {
    return { outcome: "upstream-unavailable", message: "The official MODUS statistics source is temporarily unavailable. Please try again later." };
  }
  return { outcome: "internal-error", message: "The lookup failed unexpectedly. Please try again later." };
}
