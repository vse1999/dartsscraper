import type { InlineKeyboardMarkup } from "grammy/types";
import { noopLogger, type Logger } from "../logger.js";
import { renderReportImage, type ImageReport, type ReportImageCard } from "./report-image.js";

import {
  createTelegramDeliveryPolicy,
  getTelegramRetryAfterFromResponse,
  getTelegramRetryAfterSeconds,
  isValidRetryAfterSeconds,
  TelegramRateLimitError,
  type TelegramAbortSignal,
  type TelegramDeliveryPolicy,
} from "./delivery-policy.js";

export interface TelegramMessageSender {
  readonly imagesEnabled?: boolean;
  sendReport?(chatId: number | string, report: ImageReport, options?: TelegramSendMessageOptions): Promise<void>;
  sendMessage(
    chatId: number | string,
    text: string,
    options?: TelegramSendMessageOptions,
  ): Promise<void>;
}

export interface TelegramSendMessageOptions {
  readonly replyMarkup?: InlineKeyboardMarkup;
  readonly signal?: AbortSignal;
}

export interface TelegramSenderOptions {
  readonly imagesEnabled?: boolean;
  readonly logger?: Logger;
  readonly renderImage?: (card: ReportImageCard, signal?: AbortSignal) => Promise<Buffer>;
  readonly token: string;
  readonly apiFetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly apiBaseUrl?: string;
  readonly signal?: AbortSignal;
  readonly deliveryPolicy?: TelegramDeliveryPolicy;
}

export class TelegramApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
  }
}

export function createTelegramSender(options: TelegramSenderOptions): TelegramMessageSender {
  const token = options.token.trim();
  if (token === "") throw new Error("Telegram bot token must not be empty.");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Telegram timeoutMs must be a positive integer.");
  }
  const fetchImpl = options.apiFetch ?? fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/u, "");
  const deliveryPolicy = options.deliveryPolicy ?? createTelegramDeliveryPolicy();

  const sender: TelegramMessageSender = {
    imagesEnabled: options.imagesEnabled === true,
    async sendReport(chatId: number | string, report: ImageReport, sendOptions?: TelegramSendMessageOptions): Promise<void> {
      if (!options.imagesEnabled || report.card === undefined) {
        await sendReportText(sender, chatId, report.text, sendOptions); return;
      }
      const combined = combineAbortSignals(options.signal, sendOptions?.signal);
      try {
        let png: Buffer;
        const started = performance.now();
        try { png = await (options.renderImage ?? renderReportImage)(report.card, combined.signal); }
        catch (error: unknown) {
          if (combined.signal?.aborted) throw createAbortError();
          (options.logger ?? noopLogger).warn("Report image rendering failed; using text.", { code: "REPORT_IMAGE_RENDER_FAILED", errorType: error instanceof Error ? error.name : "UnknownError" });
          await sendReportText(sender, chatId, report.text, sendOptions); return;
        }
        (options.logger ?? noopLogger).info("Report image rendered.", { renderMs: Math.round(performance.now() - started), bytes: png.byteLength });
        try {
          await deliveryPolicy.execute(makeChatKey(chatId), async (signal?: TelegramAbortSignal): Promise<void> => {
            await sendMessageRequest(fetchImpl, apiBaseUrl, token, timeoutMs, chatId, report.caption, sendOptions, signal, png);
          }, { ...(combined.signal === undefined ? {} : { signal: combined.signal }), retryAfterFromError: getTelegramRetryAfterSeconds });
          (options.logger ?? noopLogger).info("Report image delivered.", { bytes: png.byteLength });
        } catch (error: unknown) {
          // Only a definitive Telegram rejection is safe to replace. Never duplicate an ambiguously delivered photo.
          if (!(error instanceof TelegramApiError) || error.status !== 400 || combined.signal?.aborted) throw error;
          (options.logger ?? noopLogger).warn("Telegram rejected report photo; using text.", { code: "REPORT_IMAGE_REJECTED" });
          await sendReportText(sender, chatId, report.text, sendOptions);
        }
      } finally { combined.cleanup(); }
    },
    async sendMessage(
      chatId: number | string,
      text: string,
      sendOptions?: TelegramSendMessageOptions,
    ): Promise<void> {
      if (text.trim() === "") throw new Error("Telegram message must not be empty.");
      const combinedSignal = combineAbortSignals(options.signal, sendOptions?.signal);
      try {
        await deliveryPolicy.execute(
          makeChatKey(chatId),
          async (policySignal?: TelegramAbortSignal): Promise<void> => {
            await sendMessageRequest(
              fetchImpl,
              apiBaseUrl,
              token,
              timeoutMs,
              chatId,
              text,
              sendOptions,
              policySignal,
            );
          },
          {
            ...(combinedSignal.signal === undefined ? {} : { signal: combinedSignal.signal }),
            retryAfterFromError: getTelegramRetryAfterSeconds,
          },
        );
      } finally {
        combinedSignal.cleanup();
      }
    },
  };
  return sender;
}

async function sendReportText(sender: TelegramMessageSender, chatId: number | string, text: string, options?: TelegramSendMessageOptions): Promise<void> {
  if (text.trim() === "") throw new Error("Report text fallback must not be empty.");
  let remaining = text;
  while (remaining.length > 4000) {
    const boundary = remaining.lastIndexOf("\n", 4000);
    const end = boundary > 0 ? boundary : 4000;
    await sender.sendMessage(chatId, remaining.slice(0, end), options?.signal === undefined ? undefined : { signal: options.signal });
    remaining = remaining.slice(end).replace(/^\n/u, "");
  }
  await sender.sendMessage(chatId, remaining, options);
}

async function sendMessageRequest(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  timeoutMs: number,
  chatId: number | string,
  text: string,
  sendOptions: TelegramSendMessageOptions | undefined,
  policySignal?: TelegramAbortSignal,
  photo?: Buffer,
): Promise<void> {
  if (policySignal?.aborted === true) throw createAbortError();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  policySignal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout((): void => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    if (photo !== undefined) {
      form.set("chat_id", String(chatId)); form.set("caption", text); form.set("allow_paid_broadcast", "false");
      form.set("photo", new Blob([new Uint8Array(photo)], { type: "image/png" }), "darts-report.png");
      if (sendOptions?.replyMarkup !== undefined) form.set("reply_markup", JSON.stringify(sendOptions.replyMarkup));
    }
    const response = await fetchWithCancellation(fetchImpl, `${apiBaseUrl}/bot${token}/${photo === undefined ? "sendMessage" : "sendPhoto"}`, {
      method: "POST",
      headers: photo === undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: photo === undefined ? JSON.stringify({
        chat_id: chatId,
        text,
        ...(sendOptions?.replyMarkup === undefined ? {} : { reply_markup: sendOptions.replyMarkup }),
      }) : form,
      signal: controller.signal,
    }, controller.signal);
    const payload = response.status === 429 || response.ok
      ? await readResponseJson(response, controller.signal)
      : undefined;
    if (!response.ok) {
      // Non-429 error bodies are intentionally not parsed, but they still
      // need to be cancelled so a keep-alive transport can reuse the socket.
      if (response.body !== null) {
        void response.body.cancel().catch((): void => undefined);
      }
      if (response.status === 429) throw rateLimitOrHttpError(payload, response.status);
      throw new TelegramApiError(`Telegram sendMessage failed with HTTP ${response.status}.`, response.status);
    }
    if (isSuccessfulTelegramResponse(payload)) return;
    const retryAfterSeconds = getTelegramRetryAfterSecondsFromResponse(payload);
    if (retryAfterSeconds !== undefined) throw new TelegramRateLimitError(retryAfterSeconds);
    throw new TelegramApiError("Telegram sendMessage returned an unsuccessful response.", response.status);
  } catch (error: unknown) {
    if (error instanceof TelegramApiError || error instanceof TelegramRateLimitError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("Telegram sendMessage request failed.", { cause: error });
  } finally {
    clearTimeout(timeout);
    policySignal?.removeEventListener("abort", onAbort);
  }
}

function rateLimitOrHttpError(payload: unknown, status: number): TelegramRateLimitError | TelegramApiError {
  const retryAfterSeconds = getTelegramRetryAfterSecondsFromResponse(payload);
  if (retryAfterSeconds !== undefined) return new TelegramRateLimitError(retryAfterSeconds);
  return new TelegramApiError("Telegram sendMessage returned an invalid rate-limit response.", status);
}

function getTelegramRetryAfterSecondsFromResponse(value: unknown): number | undefined {
  const retryAfter = getTelegramRetryAfterFromResponse(value);
  return retryAfter !== undefined && isValidRetryAfterSeconds(retryAfter)
    ? retryAfter
    : undefined;
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): { readonly signal: AbortSignal | undefined; readonly cleanup: () => void } {
  if (first === undefined) return { signal: second, cleanup: (): void => undefined };
  if (second === undefined) return { signal: first, cleanup: (): void => undefined };
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  first.addEventListener("abort", onAbort, { once: true });
  second.addEventListener("abort", onAbort, { once: true });
  if (first.aborted || second.aborted) controller.abort();
  return {
    signal: controller.signal,
    cleanup: (): void => {
      first.removeEventListener("abort", onAbort);
      second.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchWithCancellation(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) throw createAbortError();
  const pending = fetchImpl(input, init);
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (response: Response): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(response);
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

async function readResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw createAbortError();
  const read = response.json() as Promise<unknown>;
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      if (response.body !== null) void response.body.cancel().catch((): void => undefined);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void read.then(
      (payload: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(payload);
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

function isSuccessfulTelegramResponse(value: unknown): boolean {
  return isRecord(value) && value.ok === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function makeChatKey(chatId: number | string): string {
  if (typeof chatId === "number") return `numeric:${String(chatId)}`;
  if (/^-?\d+$/u.test(chatId)) {
    try {
      return `numeric:${BigInt(chatId).toString()}`;
    } catch {
      return `text:${chatId}`;
    }
  }
  return `text:${chatId}`;
}

function createAbortError(): Error {
  const error = new Error("Telegram delivery was aborted.");
  error.name = "AbortError";
  return error;
}
