import type { Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRunOptions, AgentRunResult } from "../src/agent/harness.js";
import type { ChatAgent } from "../src/chat/server.js";
import { startChatServer } from "../src/chat/server.js";
import { noopLogger } from "../src/logger.js";

const SESSION_ID = "385c9971-7920-4a2c-9311-1a69f5758d97";
const servers: Server[] = [];

class RecordingAgent implements ChatAgent {
  public readonly requests: { query: string; options: AgentRunOptions }[] = [];

  public async run(query: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    this.requests.push({ query, options });
    return { answer: `Answer to: ${query}`, iterations: 2, toolCalls: 1, model: "gemma4:12b" };
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("local chat server", () => {
  it("serves the browser interface with restrictive security headers", async () => {
    const { url } = await startTestServer(new RecordingAgent());
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    await expect(response.text()).resolves.toContain("Darts Research");
  });

  it("passes bounded session history into follow-up agent calls", async () => {
    const agent = new RecordingAgent();
    const { url } = await startTestServer(agent);

    const first = await postChat(url, "Show Rob Cross's last ten matches.");
    expect(first.response.status).toBe(200);
    expect(first.payload).toMatchObject({ model: "gemma4:12b", metrics: { iterations: 2, toolCalls: 1 } });

    const second = await postChat(url, "What was his average?");
    expect(second.response.status).toBe(200);
    expect(agent.requests[1]).toEqual({
      query: "What was his average?",
      options: {
        history: [
          { role: "user", content: "Show Rob Cross's last ten matches." },
          { role: "assistant", content: "Answer to: Show Rob Cross's last ten matches." },
        ],
        signal: expect.any(AbortSignal),
      },
    });
  });

  it("validates content type, JSON shape, and same-origin requests", async () => {
    const { url } = await startTestServer(new RecordingAgent());
    const wrongType = await fetch(`${url}/api/chat`, { method: "POST", body: "{}" });
    expect(wrongType.status).toBe(415);

    const invalid = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "not-a-uuid", message: "hello" }),
    });
    expect(invalid.status).toBe(400);

    const crossOrigin = await fetch(`${url}/api/health`, { headers: { Origin: "https://example.com" } });
    expect(crossOrigin.status).toBe(403);
  });

  it("rejects a declared oversized body before parsing it", async () => {
    const agent = new RecordingAgent();
    const { url } = await startTestServer(agent, 100);
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "101" },
      body: "x".repeat(101),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body exceeds 100 bytes." });
    expect(agent.requests).toHaveLength(0);
  });

  it("clears server-side conversation memory", async () => {
    const agent = new RecordingAgent();
    const { url } = await startTestServer(agent);
    await postChat(url, "First question");
    const deleted = await fetch(`${url}/api/sessions/${SESSION_ID}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await postChat(url, "Fresh question");
    expect(agent.requests[1]?.options.history).toEqual([]);
  });

  it("returns an actionable response when the model is unavailable", async () => {
    const agent = new RecordingAgent();
    const started = await startChatServer({
      host: "127.0.0.1",
      port: 0,
      agent,
      model: "gemma4:12b",
      logger: noopLogger,
      staticDirectory: path.resolve(process.cwd(), "public"),
      healthChecker: { check: async () => ({ status: "model_missing", model: "gemma4:12b", message: "Run: ollama pull gemma4:12b" }) },
    });
    servers.push(started.server);
    const result = await postChat(started.url, "hello");
    expect(result.response.status).toBe(503);
    expect(result.payload).toEqual({ error: "Run: ollama pull gemma4:12b" });
    expect(agent.requests).toHaveLength(0);
  });

  it("answers supported stats through the fast path without checking or calling Ollama", async () => {
    const agent = new RecordingAgent();
    const healthCheck = vi.fn().mockRejectedValue(new Error("Ollama must not be checked"));
    const fastResearchService = {
      initialize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      tryAnswer: vi.fn().mockResolvedValue({
        answer: "Official MODUS results — 2026-08-11",
        intent: "modus-current-results" as const,
        executionMode: "fast-path" as const,
        sourceLatencyMs: 7,
        dataAgeMs: 2_000,
        fetchedAt: "2026-08-11T12:00:00.000Z",
        stale: false,
      }),
    };
    const started = await startChatServer({
      host: "127.0.0.1",
      port: 0,
      agent,
      fastResearchService,
      model: "gemma4:12b",
      logger: noopLogger,
      staticDirectory: path.resolve(process.cwd(), "public"),
      healthChecker: { check: healthCheck },
    });
    servers.push(started.server);

    const result = await postChat(started.url, "today MODUS results and averages");

    expect(result.response.status).toBe(200);
    expect(result.payload).toMatchObject({
      answer: "Official MODUS results — 2026-08-11",
      executionMode: "fast-path",
      sourceLatencyMs: 7,
      dataAgeMs: 2_000,
      metrics: { iterations: 0, toolCalls: 0 },
    });
    expect(fastResearchService.initialize).toHaveBeenCalledTimes(1);
    expect(fastResearchService.tryAnswer).toHaveBeenCalledTimes(1);
    expect(healthCheck).not.toHaveBeenCalled();
    expect(agent.requests).toHaveLength(0);
  });
});

async function startTestServer(agent: ChatAgent, maxBodyBytes = 16_384): Promise<{ url: string }> {
  const started = await startChatServer({
    host: "127.0.0.1",
    port: 0,
    agent,
    model: "gemma4:12b",
    logger: noopLogger,
    staticDirectory: path.resolve(process.cwd(), "public"),
    maxBodyBytes,
    healthChecker: { check: async () => ({ status: "ready", model: "gemma4:12b", message: "ready", ollamaVersion: "test" }) },
  });
  servers.push(started.server);
  return { url: started.url };
}

async function postChat(url: string, message: string): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID, message }),
  });
  return { response, payload: await response.json() as unknown };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
