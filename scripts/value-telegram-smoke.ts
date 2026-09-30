import { pathToFileURL } from "node:url";

import type { Update } from "grammy/types";

import type { OddsDay } from "../src/odds/contracts.js";
import { waitWithSignal } from "../src/services/cancellation.js";

const WEBHOOK_PATH = "/api/telegram-webhook";
const REQUEST_TIMEOUT_MS = 30_000;
const PRODUCTION_ORIGIN = "https://dartsscraper.vercel.app";

export interface ValueTelegramSmokeConfig {
  readonly baseUrl: string;
  readonly webhookSecret: string;
  readonly allowedUserId: number;
  readonly day: OddsDay;
  readonly now?: () => Date;
}

export interface ValueTelegramSmokeResult {
  readonly status: "accepted";
  readonly day: OddsDay;
  readonly httpStatus: number;
  readonly elapsedMs: number;
}

export function readValueTelegramSmokeConfig(
  environment: Readonly<Record<string, string | undefined>>,
  dayArgument: string | undefined,
): ValueTelegramSmokeConfig {
  const baseUrl = readBaseUrl(environment.VALUE_SMOKE_URL);
  const webhookSecret = readSecret(environment.WEBHOOK_SECRET);
  const allowedUserId = readUserId(environment.ALLOWED_USER_ID);
  const day = readDay(dayArgument);
  return { baseUrl, webhookSecret, allowedUserId, day };
}

export function buildValueTelegramSmokeUpdate(
  allowedUserId: number,
  day: OddsDay,
  now: Date = new Date(),
): Update {
  if (!Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) throw new Error("ALLOWED_USER_ID must be a positive integer.");
  if (!Number.isFinite(now.getTime())) throw new Error("Smoke clock returned an invalid date.");
  const updateId = Math.floor(now.getTime() / 1_000);
  const text = `/value ${day}`;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(now.getTime() / 1_000),
      from: { id: allowedUserId, is_bot: false, first_name: "Value smoke" },
      chat: { id: allowedUserId, type: "private", first_name: "Value smoke" },
      text,
      entities: [{ offset: 0, length: "/value".length, type: "bot_command" }],
    },
  };
}

export async function runValueTelegramSmoke(
  config: ValueTelegramSmokeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ValueTelegramSmokeResult> {
  assertProductionOrigin(config.baseUrl);
  const now = config.now ?? ((): Date => new Date());
  const startedAt = now();
  const update = buildValueTelegramSmokeUpdate(config.allowedUserId, config.day, startedAt);
  const endpoint = `${config.baseUrl}${WEBHOOK_PATH}`;
  const controller = new AbortController();
  const timeout = setTimeout((): void => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await waitWithSignal(fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": config.webhookSecret,
      },
      body: JSON.stringify(update),
      signal: controller.signal,
    }), controller.signal);
  } catch (error: unknown) {
    throw new Error("Value Telegram smoke request failed before webhook receipt.", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 200) throw new Error(`Value Telegram smoke webhook returned HTTP ${response.status}.`);
  const finishedAt = now();
  const elapsedMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  return { status: "accepted", day: config.day, httpStatus: response.status, elapsedMs };
}

function readBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") throw new Error("VALUE_SMOKE_URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error: unknown) {
    throw new Error("VALUE_SMOKE_URL must be a valid HTTPS origin.", { cause: error });
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || !/^\/?$/u.test(parsed.pathname)) {
    throw new Error("VALUE_SMOKE_URL must be an HTTPS origin without path, query, or credentials.");
  }
  if (parsed.origin !== PRODUCTION_ORIGIN) throw new Error("VALUE_SMOKE_URL must be the verified production origin.");
  return PRODUCTION_ORIGIN;
}

function assertProductionOrigin(value: string): void {
  if (value !== PRODUCTION_ORIGIN) throw new Error("VALUE_SMOKE_URL must be the verified production origin.");
}

function readSecret(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
    throw new Error("WEBHOOK_SECRET must contain 32-256 letters, digits, underscores, or hyphens.");
  }
  return value;
}

function readUserId(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) throw new Error("ALLOWED_USER_ID must be a positive integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("ALLOWED_USER_ID must be a positive integer.");
  return parsed;
}

function readDay(value: string | undefined): OddsDay {
  const day = value ?? "today";
  if (day !== "today" && day !== "tomorrow") throw new Error("Day must be today or tomorrow.");
  return day;
}

async function main(): Promise<void> {
  try {
    const config = readValueTelegramSmokeConfig(process.env, process.argv[2]);
    const result = await runValueTelegramSmoke(config);
    console.log(JSON.stringify(result));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Value Telegram smoke failed.";
    console.error(JSON.stringify({ status: "failed", error: message }));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main();
}
