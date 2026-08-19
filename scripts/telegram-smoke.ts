import type { Update } from "grammy/types";

import { handleTelegramWebhook, readWebhookSecret } from "../api/telegram-webhook.js";
import type { LogContext, Logger } from "../src/logger.js";
import { createConfiguredBot, readBotConfiguration } from "../src/telegram/bot.js";

class SmokeLogger implements Logger {
  public completedLookup = false;
  public completedProvider: string | undefined;
  public errorCount = 0;

  public debug(_message: string, _context?: LogContext): void {}
  public info(message: string, context?: LogContext): void {
    if (message === "Player statistics lookup completed.") {
      this.completedLookup = true;
      const provider = context?.provider;
      if (typeof provider === "string") this.completedProvider = provider;
    }
  }
  public warn(message: string, context?: LogContext): void {
    console.error(JSON.stringify({ level: "warn", message, context }));
  }
  public error(message: string, context?: LogContext): void {
    this.errorCount += 1;
    console.error(JSON.stringify({ level: "error", message, context }));
  }
}

process.loadEnvFile(".env.local");
const logger = new SmokeLogger();
const configuration = readBotConfiguration(process.env);
const expectedSecret = readWebhookSecret(process.env);
const bot = createConfiguredBot(process.env, logger);
await bot.init();
const requestedText = process.argv.slice(2).join(" ").trim();
const queryText = requestedText === "" ? "Rob Cross last 10 match averages" : requestedText;

const timestamp = Math.floor(Date.now() / 1_000);
const update: Update = {
  update_id: timestamp,
  message: {
    message_id: 1,
    date: timestamp,
    from: { id: configuration.allowedUserId, is_bot: false, first_name: "Owner" },
    chat: { id: configuration.allowedUserId, type: "private", first_name: "Owner" },
    text: queryText,
  },
};
let processingFailure: unknown;
const request = new Request("https://local.test/api/telegram-webhook", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-telegram-bot-api-secret-token": expectedSecret,
  },
  body: JSON.stringify(update),
});
const response = await handleTelegramWebhook(request, {
  expectedSecret,
  processUpdate: async (telegramUpdate: Update): Promise<void> => {
    try {
      await bot.handleUpdate(telegramUpdate);
    } catch (error: unknown) {
      processingFailure = error;
      throw error;
    }
  },
  logger,
});

if (
  response.status !== 200
  || !logger.completedLookup
  || logger.errorCount !== 0
) {
  if (processingFailure instanceof Error) {
    const safeMessage = processingFailure.message
      .replaceAll(configuration.token, "[redacted-token]")
      .replaceAll(String(configuration.allowedUserId), "[redacted-user-id]");
    console.error(JSON.stringify({ failureType: processingFailure.name, safeMessage }));
  }
  throw new Error("Live Telegram smoke test did not complete successfully; inspect the safe logs above.");
}

console.log(JSON.stringify({
  webhookStatus: response.status,
  updateCompletedBeforeAcknowledgement: true,
  botUsername: bot.botInfo.username,
  liveMessageDeliveredAndEdited: true,
  provider: logger.completedProvider,
}));
