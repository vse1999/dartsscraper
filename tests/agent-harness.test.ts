import { describe, expect, it, vi } from "vitest";
import { AgentLimitError, OllamaRequestError } from "../src/errors.js";
import { DartsResearchAgent } from "../src/agent/harness.js";
import { OllamaClient, type OllamaChatClient, type OllamaChatRequest, type OllamaChatResponse } from "../src/agent/ollama-client.js";
import type { AgentToolResult } from "../src/agent/tools.js";
import type { ModusResultsSnapshot } from "../src/modus/results-schemas.js";

class ScriptedClient implements OllamaChatClient {
  public readonly requests: OllamaChatRequest[] = [];
  private index = 0;
  public constructor(private readonly responses: readonly OllamaChatResponse[]) {}
  public async chat(request: OllamaChatRequest): Promise<OllamaChatResponse> {
    this.requests.push(structuredClone(request));
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
const officialModusSnapshot: ModusResultsSnapshot = {
  event: "MODUS Super Series",
  date: "2026-08-10",
  generatedAt: "2026-08-10T12:00:00Z",
  fetchedAt: "2026-08-10T12:00:01Z",
  context: { seriesId: "26", seriesName: "Series 15", weekId: "192", weekName: "Week 2", group: "Group A" },
  matches: [
    {
      id: "sr:sport_event:1", matchNumber: 1, startTime: "2026-08-10T08:38:00Z", status: "completed",
      home: { name: "Jack Drayton", score: 4, average: 91.58 },
      away: { name: "Ryan Branley", score: 2, average: 81 },
    },
    {
      id: "sr:sport_event:2", matchNumber: 2, startTime: "2026-08-10T09:00:00Z", status: "scheduled",
      home: { name: "George Cressey", score: null, average: null },
      away: { name: "Berry Van Peer", score: null, average: null },
    },
  ],
  weekAverages: [
    { position: 1, player: "George Cressey", played: 5, points: 11_472, darts: 386, average: 89.16 },
    { position: 2, player: "Jack Drayton", played: 5, points: 13_139, darts: 447, average: 88.18 },
  ],
  source: {
    dailyFeedUrl: "https://modussuperseries.com/live-scores-json.php",
    resultsUrl: "https://modussuperseries.com/results.php",
    weekAveragesUrl: "https://modussuperseries.com/week-averages.php?series_id=26&week_id=192",
  },
  warnings: [],
};

describe("bounded agent harness", () => {
  it("defaults to Gemma 4 and includes validated follow-up history", async () => {
    const client = new ScriptedClient([finalResponse]);
    const agent = new DartsResearchAgent({ client, toolExecutor: { execute: async () => ({ ok: true, data: null }) } });
    const result = await agent.run("Thank me for the context.", {
      history: [
        { role: "user", content: "Show Rob Cross's latest matches." },
        { role: "assistant", content: "Here are the matches." },
      ],
    });
    expect(result.model).toBe("gemma4:12b");
    expect(client.requests[0]).toMatchObject({
      model: "gemma4:12b",
      messages: [
        { role: "system" },
        { role: "user", content: "Show Rob Cross's latest matches." },
        { role: "assistant", content: "Here are the matches." },
        { role: "user", content: "Thank me for the context." },
      ],
    });
  });
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
  it("deduplicates identical tool calls within a model batch", async () => {
    const duplicate: OllamaChatResponse = { message: { role: "assistant", content: "", tool_calls: [
      { function: { name: "getPlayerMatchAverage", arguments: { player: "Rob Cross", limit: 3 } } },
      { function: { name: "getPlayerMatchAverage", arguments: { limit: 3, player: "Rob Cross" } } },
    ] } };
    const client = new ScriptedClient([duplicate, finalResponse]);
    let executions = 0;
    const agent = new DartsResearchAgent({ client, toolExecutor: { execute: async () => {
      executions += 1;
      return { ok: true, data: { player: "Rob Cross", requestedLimit: 3, matchCount: 3, average: 95.17 } };
    } } });
    const result = await agent.run("What is Rob Cross's last 3 match average?");
    expect(result.toolCalls).toBe(1);
    expect(executions).toBe(1);
  });
  it("reuses completed tool evidence and tells the model to stop repeating calls", async () => {
    const repeated: OllamaChatResponse = { message: { role: "assistant", content: "", tool_calls: [
      { function: { name: "getPlayerMatchAverage", arguments: { player: "Rob Cross", limit: 3 } } },
    ] } };
    const client = new ScriptedClient([repeated, repeated, finalResponse]);
    let executions = 0;
    const agent = new DartsResearchAgent({ client, toolExecutor: { execute: async () => {
      executions += 1;
      return { ok: true, data: { player: "Rob Cross", requestedLimit: 3, matchCount: 3, average: 95.17 } };
    } } });
    const result = await agent.run("What is Rob Cross's last 3 match average?");
    expect(result).toMatchObject({ answer: "Final verified answer", toolCalls: 1, iterations: 3 });
    expect(executions).toBe(1);
    expect(client.requests[2]?.messages.at(-1)?.content).toContain("already completed");
  });
  it("keeps match-row requests on the full match tool even when an average is requested", async () => {
    const rows: OllamaChatResponse = { message: { role: "assistant", content: "", tool_calls: [
      { function: { name: "getPlayerMatches", arguments: { player: "Rob Cross", limit: 3 } } },
    ] } };
    const calls: string[] = [];
    const agent = new DartsResearchAgent({ client: new ScriptedClient([rows, finalResponse]), toolExecutor: { execute: async (call) => {
      calls.push(call.name);
      return { ok: true, data: { player: { name: "Rob Cross" }, matches: [], meanMatchAverage: 95.17 } };
    } } });
    await agent.run("Show Rob Cross's last 3 completed matches and calculate the mean average.");
    expect(calls).toEqual(["getPlayerMatches"]);
  });
  it("requires fresh tool evidence for factual follow-up questions", async () => {
    const toolCall: OllamaChatResponse = { message: { role: "assistant", content: "", tool_calls: [
      { function: { name: "getPlayerMatches", arguments: { player: "Rob Cross", limit: 1 } } },
    ] } };
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Unsupported history answer" } }, toolCall, finalResponse]);
    let executions = 0;
    const agent = new DartsResearchAgent({ client, toolExecutor: { execute: async () => {
      executions += 1;
      return { ok: true, data: { player: { name: "Rob Cross" }, matches: [], meanMatchAverage: 93.82 } };
    } } });
    const result = await agent.run("Who was his most recent opponent, and what was that match average?", {
      history: [
        { role: "user", content: "Show Rob Cross's last 3 matches." },
        { role: "assistant", content: "Here are Rob Cross's matches." },
      ],
    });
    expect(result.answer).toBe("Final verified answer");
    expect(executions).toBe(1);
    expect(client.requests[1]?.messages.at(-1)?.content).toContain("Prior assistant prose is context, not evidence");
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
  it("forces the official bulk MODUS source and deterministically renders complete evidence", async () => {
    const invalidDraft: OllamaChatResponse = { message: { role: "assistant", content: "Old DartsOrakel averages only" } };
    const client = new ScriptedClient([invalidDraft, invalidDraft, invalidDraft]);
    const calls: { name: string; arguments: unknown }[] = [];
    const signals: AbortSignal[] = [];
    const agent = new DartsResearchAgent({
      client,
      now: () => new Date("2026-08-10T12:00:00Z"),
      toolExecutor: { execute: async (call, signal): Promise<AgentToolResult> => {
        calls.push(call);
        if (signal !== undefined) signals.push(signal);
        return { ok: true, data: officialModusSnapshot };
      } },
    });
    const result = await agent.run("today darts modus all matches and player averages");
    expect(calls).toEqual([{ name: "getModusResults", arguments: { date: "2026-08-10" } }]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result.toolCalls).toBe(1);
    expect(result.answer).toContain("Official MODUS Super Series results — 2026-08-10");
    expect(result.answer).toContain("| 1 | completed | Jack Drayton | 4–2 | 91.58 | Ryan Branley | 81.00 |");
    expect(result.answer).toContain("| 1 | George Cressey | 5 | 386 | 89.16 |");
    expect(result.answer).toContain("https://modussuperseries.com/live-scores-json.php");
  });
  it("maps an undated latest MODUS request to the current local date", async () => {
    const client = new ScriptedClient([
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "getModusPlayers", arguments: { date: "2025-01-01" } } }] } },
      { message: { role: "assistant", content: "Official MODUS 2026-08-10\nJack Drayton | Ryan Branley | 4–2 | 91.58 | 81.00\nGeorge Cressey | Berry Van Peer\nGeorge Cressey | 5 | 386 | 89.16\nJack Drayton | 5 | 447 | 88.18\n2026-08-10T12:00:00Z\nhttps://modussuperseries.com/live-scores-json.php\nhttps://modussuperseries.com/week-averages.php?series_id=26&week_id=192" } },
    ]);
    const calls: { name: string; arguments: unknown }[] = [];
    const agent = new DartsResearchAgent({
      client,
      now: () => new Date("2026-08-10T12:00:00Z"),
      toolExecutor: { execute: async (call): Promise<AgentToolResult> => {
        calls.push(call);
        return { ok: true, data: officialModusSnapshot };
      } },
    });

    await agent.run("latest MODUS results and overall averages");

    expect(calls).toEqual([{ name: "getModusResults", arguments: { date: "2026-08-10" } }]);
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
      expect(body).toMatchObject({ model: "gemma3:4b", keep_alive: "30m", format: { type: "object" } });
      return new Response(JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ action: "tools", calls: [{ name: "resolveDate", arguments: { expression: "Monday" } }] }) } }), { status: 200 });
    };
    const client = new OllamaClient({ fetchImpl });
    const response = await client.chat({ model: "gemma3:4b", messages: [{ role: "user", content: "Monday" }], tools: [] });
    expect(response.message.tool_calls?.[0]?.function).toEqual({ name: "resolveDate", arguments: { expression: "Monday" } });
    expect(requestCount).toBe(2);
  });
  it("sends the configured keep-alive duration to Ollama", async () => {
    let requestBody: unknown;
    const client = new OllamaClient({
      keepAlive: "45m",
      fetchImpl: async (_input, init): Promise<Response> => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(JSON.stringify({ message: { role: "assistant", content: "ready" } }), { status: 200 });
      },
    });

    await client.chat({ model: "gemma4:12b", messages: [{ role: "user", content: "hello" }], tools: [] });

    expect(requestBody).toMatchObject({ keep_alive: "45m" });
  });
  it("rejects malformed Ollama responses", async () => {
    const client = new OllamaClient({ fetchImpl: async () => new Response(JSON.stringify({ message: { role: "assistant", tool_calls: [{ function: {} }] } }), { status: 200 }) });
    await expect(client.chat({ model: "gemma", messages: [], tools: [] })).rejects.toBeInstanceOf(OllamaRequestError);
  });
  it("does not issue Ollama requests after caller cancellation", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new OllamaClient({ fetchImpl });
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));

    await expect(client.chat({ model: "gemma", messages: [], tools: [] }, controller.signal))
      .rejects.toMatchObject({ message: "Ollama request was cancelled." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("enforces the overall deadline", async () => {
    const client: OllamaChatClient = { chat: async (_request, signal) => new Promise<OllamaChatResponse>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
    const agent = new DartsResearchAgent({ client, timeoutMs: 10, toolExecutor: { execute: async () => ({ ok: true, data: null }) } });
    await expect(agent.run("research")).rejects.toThrow("deadline");
  });
  it("honors caller cancellation", async () => {
    const client: OllamaChatClient = { chat: async (_request, signal) => new Promise<OllamaChatResponse>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
    const controller = new AbortController();
    const agent = new DartsResearchAgent({ client, toolExecutor: { execute: async () => ({ ok: true, data: null }) } });
    const result = agent.run("research", { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
  });
});


