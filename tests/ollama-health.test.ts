import { describe, expect, it, vi } from "vitest";

import { createOllamaHealthChecker } from "../src/chat/ollama-health.js";

describe("Ollama health checker", () => {
  it("reports the configured installed model and caches successful checks", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "gemma4:12b", model: "gemma4:12b" }] });
      if (url.endsWith("/api/version")) return jsonResponse({ version: "0.32.7" });
      return new Response("not found", { status: 404 });
    });
    const checker = createOllamaHealthChecker({ model: "gemma4:12b", fetchImpl, cacheMs: 1_000 });

    await expect(checker.check()).resolves.toEqual({
      status: "ready",
      model: "gemma4:12b",
      ollamaVersion: "0.32.7",
      message: "Ollama and the configured model are ready.",
    });
    await checker.check();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable model installation instruction", async () => {
    const fetchImpl: typeof fetch = async (input): Promise<Response> => String(input).endsWith("/api/tags")
      ? jsonResponse({ models: [{ name: "gemma3:4b" }] })
      : jsonResponse({ version: "0.32.7" });
    const checker = createOllamaHealthChecker({ model: "gemma4:12b", fetchImpl, cacheMs: 0 });

    await expect(checker.check()).resolves.toMatchObject({
      status: "model_missing",
      message: "Model gemma4:12b is not installed. Run: ollama pull gemma4:12b",
    });
  });

  it("handles an unreachable Ollama service without throwing", async () => {
    const checker = createOllamaHealthChecker({
      model: "gemma4:12b",
      fetchImpl: async (): Promise<Response> => { throw new Error("connection refused"); },
      cacheMs: 0,
    });
    await expect(checker.check()).resolves.toMatchObject({ status: "unavailable", model: "gemma4:12b" });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
