export interface TelegramMessageSender {
  sendMessage(chatId: number | string, text: string): Promise<void>;
}

export interface TelegramSenderOptions {
  readonly token: string;
  readonly apiFetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly apiBaseUrl?: string;
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

  return {
    async sendMessage(chatId: number | string, text: string): Promise<void> {
      if (text.trim() === "") throw new Error("Telegram message must not be empty.");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${apiBaseUrl}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}.`);
        const payload: unknown = await response.json();
        if (!isSuccessfulTelegramResponse(payload)) {
          throw new Error("Telegram sendMessage returned an unsuccessful response.");
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith("Telegram ")) throw error;
        throw new Error("Telegram sendMessage request failed.", { cause: error });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function isSuccessfulTelegramResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "ok") === true;
}
