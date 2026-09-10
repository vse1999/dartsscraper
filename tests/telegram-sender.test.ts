import { describe, expect, it, vi } from "vitest";

import { createTelegramSender } from "../src/telegram/sender.js";

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
});
