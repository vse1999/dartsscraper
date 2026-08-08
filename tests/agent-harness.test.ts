import { describe, expect, it } from "vitest";
import { AgentLimitError, OllamaRequestError } from "../src/errors.js";
import { DartsResearchAgent } from "../src/agent/harness.js";
import { OllamaClient, type OllamaChatClient, type OllamaChatRequest, type OllamaChatResponse } from "../src/agent/ollama-client.js";
import type { AgentToolResult } from "../src/agent/tools.js";

class ScriptedClient implements OllamaChatClient {
  public readonly requests: OllamaChatRequest[] = [];
  private index = 0;
  public constructor(private readonly responses: readonly OllamaChatResponse[]) {}
  public async chat(request: OllamaChatRequest): Promise<OllamaChatResponse> {
    this.requests.push(request);
    const response = this.responses[this.index];
    this.index += 1;
    if (response === undefined) throw new Error("No scripted response.");
    return response;
  }
}
function toolResponse(count: number): OllamaChatResponse {
  return { message: { role: "assistant", content: "", tool_calls: Array.from({ length: count }, (_value, index) => ({ function: { name: "getPlayerMatchAverage", arguments: { player: `Player ${index}`, limit: 10 } } })) } };
}
const finalResponse: OllamaChatResponse = { message: { role: "assistant", content: "Final verified answer" } };

describe("bounded agent harness", () => {
  it("runs independent tool calls with controlled concurrency", async () => {
    const client = new ScriptedClient([toolResponse(6), finalResponse]);
    let active = 0; let maximum = 0;
    const agent = new DartsResearchAgent({ client, concurrency: 3, toolExecutor: { execute: async (): Promise<AgentToolResult> => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active -= 1; return { ok: true, data: { average: 90 } };
    } } });
    const result = await agent.run("research");
    expect(result).toMatchObject({ answer: "Final verified answer", iterations: 2, toolCalls: 6 });
    expect(maximum).toBe(3);
  });
  it("keeps partial failures in tool messages for final formatting", async () => {
    const client = new ScriptedClient([toolResponse(2), finalResponse]);
    let invocation = 0;
    const agent = new DartsResearchAgent({ client, toolExecutor: { execute: async (): Promise<AgentToolResult> => {
      invocation += 1;
      return invocation === 1 ? { ok: true, data: { average: 91 } } : { ok: false, error: { code: "TOOL_FAILED", message: "unavailable" } };
    } } });
    await agent.run("research");
    const secondRequest = client.requests[1];
    expect(secondRequest?.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content) as unknown)).toEqual([
      { ok: true, data: { average: 91 } }, { ok: false, error: { code: "TOOL_FAILED", message: "unavailable" } },
    ]);
  });
  it("stops at the maximum tool call count", async () => {
    const agent = new DartsResearchAgent({ client: new ScriptedClient([toolResponse(2)]), maxToolCalls: 1, toolExecutor: { execute: async () => ({ ok: true, data: null }) } });
    await expect(agent.run("research")).rejects.toBeInstanceOf(AgentLimitError);
  });
  it("stops at the maximum iteration count", async () => {
    const agent = new DartsResearchAgent({ client: new ScriptedClient([toolResponse(1)]), maxIterations: 1, toolExecutor: { execute: async () => ({ ok: true, data: null }) } });
    await expect(agent.run("research")).rejects.toThrow("maximum of 1 iterations");
  });
  it("guards the resolved date and replaces hallucinated players with discovered MODUS players", async () => {
    const discovery: OllamaChatResponse = { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "getModusPlayers", arguments: { date: "2026-08-08" } } }] } };
    const hallucinated: OllamaChatResponse = { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "getPlayerMatchAverage", arguments: { player: "Invented Player", limit: 10 } } }] } };
    const final: OllamaChatResponse = { message: { role: "assistant", content: "2026-08-10 Actual One 90.00 Actual Two 91.00" } };
    const client = new ScriptedClient([discovery, hallucinated, final]);
    const calls: { name: string; arguments: unknown }[] = [];
    const agent = new DartsResearchAgent({
      client, now: () => new Date("2026-08-08T12:00:00Z"),
      toolExecutor: { execute: async (call): Promise<AgentToolResult> => {
        calls.push(call);
        if (call.name === "getModusPlayers") return { ok: true, data: { event: "MODUS Super Series", date: "2026-08-10", players: [{ name: "Actual One", source: "https://example.com", confidence: 1 }, { name: "Actual Two", source: "https://example.com", confidence: 1 }] } };
        const player = typeof call.arguments === "object" && call.arguments !== null && "player" in call.arguments ? String(call.arguments.player) : "Unknown";
        return { ok: true, data: { player, requestedLimit: 10, matchCount: 10, average: player === "Actual One" ? 90 : 91 } };
      } },
    });
    await expect(agent.run("MODUS Monday last 10 match average")).resolves.toMatchObject({ answer: final.message.content });
    expect(calls).toEqual([
      { name: "getModusPlayers", arguments: { date: "2026-08-10" } },
      { name: "getPlayerMatchAverage", arguments: { player: "Actual One", limit: 10 } },
      { name: "getPlayerMatchAverage", arguments: { player: "Actual Two", limit: 10 } },
    ]);
  });  it("falls back to the validated JSON protocol for Gemma models without native tools", async () => {
    let requestCount = 0;
    const fetchImpl: typeof fetch = async (_input, init): Promise<Response> => {
      requestCount += 1;
      if (requestCount === 1) return new Response(JSON.stringify({ error: "gemma does not support tools" }), { status: 400 });
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "gemma3:4b", format: { type: "object" } });
      return new Response(JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ action: "tools", calls: [{ name: "resolveDate", arguments: { expression: "Monday" } }] }) } }), { status: 200 });
    };
    const client = new OllamaClient({ fetchImpl });
    const response = await client.chat({ model: "gemma3:4b", messages: [{ role: "user", content: "Monday" }], tools: [] });
    expect(response.message.tool_calls?.[0]?.function).toEqual({ name: "resolveDate", arguments: { expression: "Monday" } });
    expect(requestCount).toBe(2);
  });  it("rejects malformed Ollama responses", async () => {
    const client = new OllamaClient({ fetchImpl: async () => new Response(JSON.stringify({ message: { role: "assistant", tool_calls: [{ function: {} }] } }), { status: 200 }) });
    await expect(client.chat({ model: "gemma", messages: [], tools: [] })).rejects.toBeInstanceOf(OllamaRequestError);
  });
  it("enforces the overall deadline", async () => {
    const client: OllamaChatClient = { chat: async (_request, signal) => new Promise<OllamaChatResponse>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
    const agent = new DartsResearchAgent({ client, timeoutMs: 10, toolExecutor: { execute: async () => ({ ok: true, data: null }) } });
    await expect(agent.run("research")).rejects.toThrow("deadline");
  });
});


