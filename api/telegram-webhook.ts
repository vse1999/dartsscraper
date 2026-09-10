import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import type { Bot, Context } from "grammy";
import type { Update } from "grammy/types";
import { waitUntil } from "@vercel/functions";

import { ConsoleLogger, type Logger } from "../src/logger.js";
import { createConfiguredBot } from "../src/telegram/bot.js";

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const MAX_UPDATE_BYTES = 64 * 1_024;

export const config = { maxDuration: 180 };

export interface WebhookEnvironment {
  readonly WEBHOOK_SECRET?: string;
}

export interface WebhookDependencies {
  readonly expectedSecret: string;
  readonly processUpdate: (update: Update) => Promise<void>;
  readonly logger: Logger;
}

const productionLogger = new ConsoleLogger({ minimumLevel: "info" });
let productionBot: Bot<Context> | undefined;
let botInitialization: Promise<void> | undefined;

export function readWebhookSecret(environment: WebhookEnvironment): string {
  const secret = environment.WEBHOOK_SECRET?.trim();
  if (secret === undefined || !/^[A-Za-z0-9_-]{32,256}$/u.test(secret)) {
    throw new Error("WEBHOOK_SECRET must contain 32-256 letters, digits, underscores, or hyphens.");
  }
  return secret;
}

export async function handleTelegramWebhook(
  request: Request,
  dependencies: WebhookDependencies,
): Promise<Response> {
  if (request.method !== "POST") return notFound();
  const actualSecret = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (!hasValidSecret(actualSecret, dependencies.expectedSecret)) return notFound();

  try {
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      const declaredBytes = Number(declaredLength);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_UPDATE_BYTES) {
        return invalidUpdate();
      }
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_UPDATE_BYTES) {
      return invalidUpdate();
    }
    const parsed: unknown = JSON.parse(rawBody);
    const update = parseTelegramUpdate(parsed);
    try {
      await dependencies.processUpdate(update);
    } catch (error: unknown) {
      dependencies.logger.error("Telegram update processing failed.", {
        updateId: update.update_id,
        code: "TELEGRAM_UPDATE_FAILED",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return temporarilyUnavailable();
    }
    return new Response(null, { status: 200, headers: securityHeaders() });
  } catch {
    dependencies.logger.warn("Authenticated webhook request contained an invalid update.", {
      code: "INVALID_WEBHOOK_UPDATE",
    });
    return invalidUpdate();
  }
}

async function productionFetch(request: Request): Promise<Response> {
  const expectedSecret = readWebhookSecret(process.env);
  return handleTelegramWebhook(request, {
    expectedSecret,
    processUpdate: processProductionUpdate,
    logger: productionLogger,
  });
}

interface VercelNodeRequest extends IncomingMessage {
  readonly body?: unknown;
}

async function telegramWebhook(request: VercelNodeRequest, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const webRequest = new Request(requestUrl(request), {
    method,
    headers: webHeaders(request.headers),
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: await requestBody(request) }),
  });
  const webResponse = await productionFetch(webRequest);
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value: string, name: string): void => {
    response.setHeader(name, value);
  });
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

function requestUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? "localhost";
  return `https://${host}${request.url ?? "/"}`;
}

function webHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result.set(name, value);
    else if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    }
  }
  return result;
}

async function requestBody(request: VercelNodeRequest): Promise<string> {
  if (typeof request.body === "string") return request.body;
  if (request.body instanceof Uint8Array) return Buffer.from(request.body).toString("utf8");
  if (request.body !== undefined) return JSON.stringify(request.body);

  const chunks: Buffer[] = [];
  for await (const rawChunk of request as AsyncIterable<unknown>) {
    if (typeof rawChunk === "string" || rawChunk instanceof Uint8Array) {
      chunks.push(Buffer.from(rawChunk));
      continue;
    }
    throw new Error("Webhook request contained an unsupported body chunk.");
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function processProductionUpdate(update: Update): Promise<void> {
  const bot = getProductionBot();
  await ensureBotInitialized(bot);
  await bot.handleUpdate(update);
}

function getProductionBot(): Bot<Context> {
  productionBot ??= createConfiguredBot(process.env, productionLogger, waitUntil);
  return productionBot;
}

function ensureBotInitialized(bot: Bot<Context>): Promise<void> {
  botInitialization ??= bot.init().catch((error: unknown) => {
    botInitialization = undefined;
    throw error;
  });
  return botInitialization;
}

function parseTelegramUpdate(value: unknown): Update {
  if (typeof value !== "object" || value === null) {
    throw new Error("Telegram update must be an object.");
  }
  const updateId = Reflect.get(value, "update_id");
  if (!Number.isSafeInteger(updateId) || Number(updateId) < 0) {
    throw new Error("Telegram update_id is invalid.");
  }
  return value as Update;
}

function hasValidSecret(actualSecret: string | null, expectedSecret: string): boolean {
  if (actualSecret === null) return false;
  const actual = Buffer.from(actualSecret, "utf8");
  const expected = Buffer.from(expectedSecret, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function securityHeaders(): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-length": "0",
    "x-content-type-options": "nosniff",
  };
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: securityHeaders() });
}

function invalidUpdate(): Response {
  return new Response("invalid update", {
    status: 400,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function temporarilyUnavailable(): Response {
  return new Response("temporarily unavailable", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "1",
      "x-content-type-options": "nosniff",
    },
  });
}

export default telegramWebhook;
