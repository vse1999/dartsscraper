import { describe, expect, it, vi } from "vitest";

import {
  buildValueTelegramSmokeUpdate,
  readValueTelegramSmokeConfig,
  runValueTelegramSmoke,
} from "../scripts/value-telegram-smoke.js";

const SECRET = "a".repeat(32);
const ENV = { VALUE_SMOKE_URL: "https://dartsscraper.vercel.app/", WEBHOOK_SECRET: SECRET, ALLOWED_USER_ID: "123" };

function fixedClock(): () => Date {
  const values = [new Date("2026-09-30T18:00:00.000Z"), new Date("2026-09-30T18:00:00.250Z")];
  let index = 0;
  return (): Date => values[Math.min(index++, values.length - 1)] ?? new Date("2026-09-30T18:00:00.250Z");
}

describe("value Telegram smoke", () => {
  it("validates explicit origin, secret, owner ID, and day", () => {
    expect(readValueTelegramSmokeConfig(ENV, "tomorrow")).toEqual({
      baseUrl: "https://dartsscraper.vercel.app",
      webhookSecret: SECRET,
      allowedUserId: 123,
      day: "tomorrow",
    });
    expect(() => readValueTelegramSmokeConfig({ ...ENV, VALUE_SMOKE_URL: "https://example.vercel.app" }, "today")).toThrow("verified production origin");
    expect(() => readValueTelegramSmokeConfig({ ...ENV, VALUE_SMOKE_URL: "http://example.vercel.app" }, "today")).toThrow("HTTPS");
    expect(() => readValueTelegramSmokeConfig({ ...ENV, WEBHOOK_SECRET: "short" }, "today")).toThrow("WEBHOOK_SECRET");
    expect(() => readValueTelegramSmokeConfig(ENV, "next-week")).toThrow("today or tomorrow");
  });

  it("posts exactly one authorized private update and returns receipt metadata only", async () => {
    const config = { ...readValueTelegramSmokeConfig(ENV, "today"), now: fixedClock() };
    let calls = 0;
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1;
      requestUrl = String(input);
      requestInit = init;
      return new Response(null, { status: 200 });
    };
    const result = await runValueTelegramSmoke(config, fakeFetch);
    expect(calls).toBe(1);
    expect(requestUrl).toBe("https://dartsscraper.vercel.app/api/telegram-webhook");
    expect(new Headers(requestInit?.headers).get("x-telegram-bot-api-secret-token")).toBe(SECRET);
    expect(requestInit?.redirect).toBe("error");
    const body: unknown = JSON.parse(String(requestInit?.body));
    expect(body).toMatchObject({ message: { chat: { id: 123, type: "private" }, text: "/value today" } });
    expect(result).toEqual({ status: "accepted", day: "today", httpStatus: 200, elapsedMs: 250 });
  });

  it("masks non-200 response bodies and network details", async () => {
    const config = { ...readValueTelegramSmokeConfig(ENV, "today"), now: fixedClock() };
    const rejectedFetch: typeof fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret response body"));
    await expect(runValueTelegramSmoke(config, rejectedFetch)).rejects.toThrow("failed before webhook receipt");
    const badFetch: typeof fetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("private HTML", { status: 503 }));
    await expect(runValueTelegramSmoke(config, badFetch)).rejects.toThrow("HTTP 503");
    await expect(runValueTelegramSmoke(config, badFetch)).rejects.not.toThrow("private HTML");
  });

  it("builds a private owner update without a bot token or raw diagnostics", () => {
    const update = buildValueTelegramSmokeUpdate(123, "tomorrow", new Date("2026-09-30T18:00:00.000Z"));
    expect(update.message?.chat.type).toBe("private");
    expect(update.message?.from?.id).toBe(123);
    expect(update.message?.entities?.[0]?.length).toBe(6);
    expect(JSON.stringify(update)).not.toMatch(/bot_token|webhook_secret/iu);
  });

  it("revalidates the production origin and bounds a fetch that ignores abort", async () => {
    const config = { ...readValueTelegramSmokeConfig(ENV, "today"), now: fixedClock() };
    const unapprovedFetch = vi.fn<typeof fetch>();
    await expect(runValueTelegramSmoke({ ...config, baseUrl: "https://example.vercel.app" }, unapprovedFetch)).rejects.toThrow("verified production origin");
    expect(unapprovedFetch).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      const neverSettles: typeof fetch = vi.fn(async (): Promise<Response> => new Promise<Response>(() => undefined));
      const pending = runValueTelegramSmoke(config, neverSettles);
      const rejection = expect(pending).rejects.toThrow("failed before webhook receipt");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
