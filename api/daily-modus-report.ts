import { timingSafeEqual } from "node:crypto";

import { DartsOrakelClient } from "../src/dartsorakel/client.js";
import { createJinaReaderFetch } from "../src/dartsorakel/reader-fetch.js";
import { DartsOrakelScraper } from "../src/dartsorakel/scraper.js";
import { resolveResearchDate } from "../src/agent/date.js";
import { DartsNerdModusSource } from "../src/modus/darts-nerd-source.js";
import { FixtureNameResolver } from "../src/modus/fixture-name-resolver.js";
import { OfficialModusSource } from "../src/modus/official-source.js";
import { ModusPlayersService } from "../src/modus/service.js";
import { PlayerResolver } from "../src/player/resolver.js";
import { PlayerMatchesService } from "../src/services/player-matches.js";
import { ConsoleLogger, type Logger } from "../src/logger.js";
import { createTelegramSender } from "../src/telegram/sender.js";
import { readBotConfiguration } from "../src/telegram/bot.js";
import { DartsPlayerStatsService } from "../src/telegram/stats-service.js";
import { runModusReport, type ModusReportResult } from "../src/daily/modus-report.js";
import type { ModusReportDateExpression } from "../src/telegram/modus-command.js";

const DARTSORAKEL_TIMEOUT_MS = 15_000;
const CRON_AUTHORIZATION_PREFIX = "Bearer ";

export const config = { maxDuration: 180 };

export interface DailyReportEnvironment {
  readonly BOT_TOKEN?: string;
  readonly ALLOWED_USER_ID?: string;
  readonly CRON_SECRET?: string;
}

export interface DailyReportDependencies {
  readonly expectedSecret: string;
  readonly execute: (date?: ModusReportDateExpression) => Promise<ModusReportResult>;
  readonly logger: Logger;
}

export function readCronSecret(environment: DailyReportEnvironment): string {
  const secret = environment.CRON_SECRET?.trim();
  if (secret === undefined || !/^[A-Za-z0-9_-]{32,256}$/u.test(secret)) {
    throw new Error("CRON_SECRET must contain 32-256 letters, digits, underscores, or hyphens.");
  }
  return secret;
}

export async function handleDailyModusReport(
  request: Request,
  dependencies: DailyReportDependencies,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 404 });
  if (!hasValidAuthorization(request.headers.get("authorization"), dependencies.expectedSecret)) {
    return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }

  let requestedDate: ModusReportDateExpression | undefined;
  try {
    requestedDate = parseRequestedDate(request.url);
  } catch {
    return new Response("invalid date", {
      status: 400,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }

  try {
    const result = await dependencies.execute(requestedDate);
    const succeeded = result.results.filter((player) => player.status === "succeeded").length;
    return new Response(JSON.stringify({
      ok: true,
      date: result.date,
      players: result.players.length,
      succeeded,
      failed: result.results.length - succeeded,
      discoverySucceeded: result.discoverySucceeded,
    }), {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    });
  } catch (error: unknown) {
    dependencies.logger.error("MODUS daily report execution failed.", {
      success: false,
      failureCode: "MODUS_REPORT_EXECUTION_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return new Response("daily report failed", {
      status: 500,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
}

async function productionFetch(request: Request): Promise<Response> {
  const expectedSecret = readCronSecret(process.env);
  return handleDailyModusReport(request, {
    expectedSecret,
    execute: executeProductionReport,
    logger: new ConsoleLogger({ minimumLevel: "info" }),
  });
}

async function executeProductionReport(dateExpression?: ModusReportDateExpression): Promise<ModusReportResult> {
  const logger = new ConsoleLogger({ minimumLevel: "info" });
  const botConfiguration = readBotConfiguration(process.env);
  const client = new DartsOrakelClient({
    timeoutMs: DARTSORAKEL_TIMEOUT_MS,
    maxRetries: 0,
    minRequestIntervalMs: 250,
    logger,
    fetchImpl: createJinaReaderFetch(),
  });
  const playerResolver = new PlayerResolver(client);
  const scraper = new DartsOrakelScraper(client);
  const playerMatchesService = new PlayerMatchesService({
    resolver: playerResolver,
    scraper,
    logger,
  });
  const statsService = new DartsPlayerStatsService(playerMatchesService);
  const fixtureNameResolver = new FixtureNameResolver(client);
  const modusPlayersService = new ModusPlayersService({
    sources: [
      new OfficialModusSource({ resolver: fixtureNameResolver }),
      new DartsNerdModusSource({ resolver: fixtureNameResolver }),
    ],
    logger,
  });
  const telegram = createTelegramSender({ token: botConfiguration.token });

  return runModusReport({
    date: resolveResearchDate(dateExpression ?? "tomorrow", { timeZone: "Europe/Budapest" }).date,
    matchCount: 10,
    chatId: botConfiguration.allowedUserId,
    concurrency: 3,
    dependencies: {
      modusPlayersService,
      playerStatsService: statsService,
      telegram,
      logger,
    },
  });
}

function parseRequestedDate(requestUrl: string): ModusReportDateExpression | undefined {
  const value = new URL(requestUrl).searchParams.get("date");
  if (value === null || value === "") return undefined;
  if (value === "today" || value === "tomorrow") return value;
  throw new Error("date must be today or tomorrow.");
}

function hasValidAuthorization(actualHeader: string | null, expectedSecret: string): boolean {
  if (actualHeader === null || !actualHeader.startsWith(CRON_AUTHORIZATION_PREFIX)) return false;
  const actual = Buffer.from(actualHeader.slice(CRON_AUTHORIZATION_PREFIX.length), "utf8");
  const expected = Buffer.from(expectedSecret, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export default { fetch: productionFetch };
