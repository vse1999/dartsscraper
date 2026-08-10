import { AgentLimitError } from "../errors.js";
import { noopLogger, type Logger } from "../logger.js";
import { ModusPlayersResultSchema } from "../modus/schemas.js";
import { normalizePlayerName } from "../player/resolver.js";
import { resolveResearchDate, type ResolvedDate } from "./date.js";
import { AGENT_TOOL_DEFINITIONS, type AgentToolCall, type AgentToolResult, type DartsAgentToolExecutor } from "./tools.js";
import type { OllamaChatClient, OllamaMessage, OllamaToolCall } from "./ollama-client.js";
import { DEFAULT_OLLAMA_MODEL } from "./config.js";

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_TOOL_CALLS = 32;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_CONCURRENCY = 3;

export interface DartsResearchAgentOptions {
  client: OllamaChatClient;
  toolExecutor: Pick<DartsAgentToolExecutor, "execute">;
  model?: string;
  maxIterations?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => Date;
  timeZone?: string;
  logger?: Logger;
}
export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: string;
}
export interface AgentRunOptions {
  history?: readonly AgentConversationMessage[];
  signal?: AbortSignal;
}
export interface AgentRunResult { answer: string; iterations: number; toolCalls: number; model: string; }
interface AverageEvidence { player: string; average: number | null; matchCount: number; error?: string; }
interface ExecutedTool { call: AgentToolCall; result: AgentToolResult; }

export class DartsResearchAgent {
  private readonly client: OllamaChatClient;
  private readonly toolExecutor: Pick<DartsAgentToolExecutor, "execute">;
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly maxToolCalls: number;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly logger: Logger;
  public constructor(options: DartsResearchAgentOptions) {
    this.client = options.client;
    this.toolExecutor = options.toolExecutor;
    this.model = options.model ?? DEFAULT_OLLAMA_MODEL;
    this.maxIterations = positiveInteger(options.maxIterations ?? DEFAULT_MAX_ITERATIONS, "maxIterations");
    this.maxToolCalls = positiveInteger(options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, "maxToolCalls");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.concurrency = positiveInteger(options.concurrency ?? DEFAULT_CONCURRENCY, "concurrency");
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? "Europe/Budapest";
    this.logger = options.logger ?? noopLogger;
  }

  public async run(query: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const trimmed = query.trim();
    if (trimmed === "") throw new Error("Research query must not be empty.");
    const history = validateConversationHistory(options.history ?? []);
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(options.signal?.reason ?? new Error("Agent request was cancelled."));
    if (options.signal?.aborted === true) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Agent deadline exceeded.")), this.timeoutMs);
    const resolvedDate = this.tryResolveDate(trimmed);
    const normalizedQuery = trimmed.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US");
    const modusResearch = normalizedQuery.includes("modus");
    const preferAverageTool = /\b(average|mean|atlag)/i.test(normalizedQuery);
    const messages: OllamaMessage[] = [
      { role: "system", content: this.systemPrompt(resolvedDate) },
      ...history,
      { role: "user", content: trimmed },
    ];
    let toolCallCount = 0;
    let discoveredPlayers: readonly string[] = [];
    const averageEvidence = new Map<string, AverageEvidence>();
    let answerRepairAttempts = 0;

    try {
      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        if (controller.signal.aborted) throw new AgentLimitError(`Agent exceeded its ${this.timeoutMs}ms deadline.`);
        const response = await this.client.chat({ model: this.model, messages, tools: AGENT_TOOL_DEFINITIONS }, controller.signal);
        messages.push(response.message);
        const modelCalls = response.message.tool_calls?.map((call) => ({ name: call.function.name, arguments: call.function.arguments })) ?? [];
        const plannedCalls = this.planCalls({
          modelCalls, resolvedDate, modusResearch, preferAverageTool, discoveredPlayers,
          averageEvidence, query: normalizedQuery, modelReturnedFinal: modelCalls.length === 0,
        });

        if (plannedCalls.length === 0) {
          const answer = response.message.content.trim();
          if (answer === "") throw new Error("The model returned neither executable tool calls nor a final answer.");
          if (modusResearch && preferAverageTool && discoveredPlayers.length > 0 && !validateEvidenceAnswer(answer, discoveredPlayers, averageEvidence, resolvedDate?.date)) {
            answerRepairAttempts += 1;
            if (answerRepairAttempts >= 2) {
              return { answer: deterministicEvidenceAnswer(trimmed, resolvedDate?.date, discoveredPlayers, averageEvidence), iterations: iteration, toolCalls: toolCallCount, model: this.model };
            }
            messages.push({ role: "user", content: `Your draft failed evidence validation. Use every player exactly once and only these deterministic results. Do not add other players or numbers:\n${JSON.stringify([...averageEvidence.values()])}` });
            continue;
          }
          return { answer, iterations: iteration, toolCalls: toolCallCount, model: this.model };
        }

        if (toolCallCount + plannedCalls.length > this.maxToolCalls) throw new AgentLimitError(`Agent exceeded the maximum of ${this.maxToolCalls} tool calls.`);
        toolCallCount += plannedCalls.length;
        messages[messages.length - 1] = { role: "assistant", content: "", tool_calls: plannedCalls.map(toOllamaToolCall) };
        const executed = await mapWithConcurrency(plannedCalls, this.concurrency, async (call, index): Promise<ExecutedTool> => {
          const startedAt = Date.now();
          const result = await this.toolExecutor.execute(call);
          this.logger.debug("Agent tool completed.", {
            tool: call.name, arguments: call.arguments, index, durationMs: Date.now() - startedAt,
            ok: result.ok, errorCode: result.ok ? undefined : result.error.code,
          });
          return { call, result };
        });
        for (const item of executed) {
          this.collectEvidence(item, averageEvidence, (players) => { discoveredPlayers = players; });
          messages.push({ role: "tool", tool_name: item.call.name, content: JSON.stringify(item.result) });
        }
      }
      throw new AgentLimitError(`Agent exceeded the maximum of ${this.maxIterations} iterations.`);
    } catch (error: unknown) {
      if (controller.signal.aborted && !(error instanceof AgentLimitError)) {
        if (options.signal?.aborted === true) throw new AgentLimitError("Agent request was cancelled.");
        throw new AgentLimitError(`Agent exceeded its ${this.timeoutMs}ms deadline.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private planCalls(input: {
    modelCalls: readonly AgentToolCall[];
    resolvedDate: ResolvedDate | undefined;
    modusResearch: boolean;
    preferAverageTool: boolean;
    discoveredPlayers: readonly string[];
    averageEvidence: ReadonlyMap<string, AverageEvidence>;
    query: string;
    modelReturnedFinal: boolean;
  }): readonly AgentToolCall[] {
    const guarded = input.modelCalls.map((call) => this.guardToolCall(call, input.resolvedDate, input.preferAverageTool));
    if (!input.modusResearch) return guarded;
    if (input.discoveredPlayers.length === 0) {
      return guarded.filter((call) => call.name !== "getPlayerMatches" && call.name !== "getPlayerMatchAverage");
    }
    if (!input.preferAverageTool) return guarded;
    const missingPlayers = input.discoveredPlayers.filter((player) => !input.averageEvidence.has(normalizePlayerName(player)));
    const requestedPlayerCall = guarded.find((call) => call.name === "getPlayerMatchAverage" || call.name === "getPlayerMatches");
    if (missingPlayers.length > 0 && (requestedPlayerCall !== undefined || input.modelReturnedFinal)) {
      const limit = extractLimit(requestedPlayerCall?.arguments, input.query);
      return missingPlayers.map((player) => ({ name: "getPlayerMatchAverage", arguments: { player, limit } }));
    }
    return guarded.filter((call) => call.name !== "getPlayerMatches" && call.name !== "getPlayerMatchAverage" && call.name !== "getModusPlayers");
  }

  private collectEvidence(item: ExecutedTool, averageEvidence: Map<string, AverageEvidence>, setPlayers: (players: readonly string[]) => void): void {
    if (item.call.name === "getModusPlayers" && item.result.ok) {
      const parsed = ModusPlayersResultSchema.safeParse(item.result.data);
      if (parsed.success) setPlayers(parsed.data.players.map((player) => player.name));
      return;
    }
    if (item.call.name !== "getPlayerMatchAverage") return;
    const playerArgument = readStringProperty(item.call.arguments, "player") ?? "Unknown player";
    const key = normalizePlayerName(playerArgument);
    if (!item.result.ok) {
      averageEvidence.set(key, { player: playerArgument, average: null, matchCount: 0, error: item.result.error.message });
      return;
    }
    const player = readStringProperty(item.result.data, "player") ?? playerArgument;
    const average = readNumberOrNullProperty(item.result.data, "average");
    const matchCount = readNumberProperty(item.result.data, "matchCount") ?? 0;
    averageEvidence.set(key, { player, average, matchCount });
  }

  private tryResolveDate(query: string): ResolvedDate | undefined {
    try { return resolveResearchDate(query, { now: this.now(), timeZone: this.timeZone }); }
    catch { return undefined; }
  }
  private guardToolCall(call: AgentToolCall, resolvedDate: ResolvedDate | undefined, preferAverageTool: boolean): AgentToolCall {
    if (call.name === "getPlayerMatches" && preferAverageTool) return { name: "getPlayerMatchAverage", arguments: call.arguments };
    if (call.name !== "getModusPlayers" || resolvedDate === undefined) return call;
    return { name: call.name, arguments: { date: resolvedDate.date } };
  }
  private systemPrompt(resolvedDate: ResolvedDate | undefined): string {
    return [
      "You are a local darts research orchestrator. Use tools for every date, fixture, match, and numeric fact.",
      "Use the supplied conversation history to understand follow-up questions, but never treat prior assistant text as verified evidence.",
      "Never invent players, matches, averages, dates, or unavailable results. Never calculate averages yourself.",
      "For relative dates call resolveDate first. Then call getModusPlayers. Use only returned players and call getPlayerMatchAverage for each requested average.",
      "Put all independent player calls in one parallel batch. Preserve tool errors as explicit unavailable rows.",
      "Answer in the user's language with a compact table. State the ISO date, actual sample size, source limitations, and partial failures.",
      `Current instant: ${this.now().toISOString()}. Time zone: ${this.timeZone}.`,
      resolvedDate === undefined ? "No deterministic date was pre-resolved." : `Deterministic date guard: every date reference in this single-date query resolves to ${resolvedDate.date}. Use exactly this date for fixture tools.`,
    ].join("\n");
  }
}

function extractLimit(argumentsValue: unknown, query: string): number {
  const fromArguments = readNumberProperty(argumentsValue, "limit");
  if (fromArguments !== undefined && Number.isInteger(fromArguments) && fromArguments > 0 && fromArguments <= 1000) return fromArguments;
  const fromQuery = /\b(\d{1,3})\b/.exec(query)?.[1];
  const parsed = fromQuery === undefined ? 10 : Number(fromQuery);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : 10;
}
function validateEvidenceAnswer(answer: string, players: readonly string[], evidence: ReadonlyMap<string, AverageEvidence>, date: string | undefined): boolean {
  if (date !== undefined && !answer.includes(date)) return false;
  const normalizedAnswer = normalizePlayerName(answer);
  return players.every((player) => {
    const item = evidence.get(normalizePlayerName(player));
    if (item === undefined || !normalizedAnswer.includes(normalizePlayerName(player))) return false;
    if (item.average === null) return true;
    return answer.includes(item.average.toFixed(2)) || answer.includes(String(item.average));
  });
}
function deterministicEvidenceAnswer(query: string, date: string | undefined, players: readonly string[], evidence: ReadonlyMap<string, AverageEvidence>): string {
  const hungarian = /[áéíóöőúüű]|\b(keresd|játékos|meccs|átlag)/i.test(query);
  const header = hungarian ? `MODUS Super Series – ${date ?? "ismeretlen dátum"}` : `MODUS Super Series — ${date ?? "unknown date"}`;
  const columns = hungarian ? "| Játékos | Meccsek | Átlag | Állapot |\n|---|---:|---:|---|" : "| Player | Matches | Average | Status |\n|---|---:|---:|---|";
  const rows = players.map((player) => {
    const item = evidence.get(normalizePlayerName(player));
    if (item === undefined || item.average === null) return `| ${player} | ${item?.matchCount ?? 0} | — | ${item?.error ?? (hungarian ? "Nem elérhető" : "Unavailable")} |`;
    return `| ${player} | ${item.matchCount} | ${item.average.toFixed(2)} | ${hungarian ? "Rendben" : "OK"} |`;
  });
  return `${header}\n\n${columns}\n${rows.join("\n")}`;
}
function toOllamaToolCall(call: AgentToolCall): OllamaToolCall { return { function: { name: call.name, arguments: call.arguments } }; }
function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const property = value[key as keyof typeof value];
  return typeof property === "string" ? property : undefined;
}
function readNumberProperty(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const property = value[key as keyof typeof value];
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}
function readNumberOrNullProperty(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const property = value[key as keyof typeof value];
  return property === null ? null : typeof property === "number" && Number.isFinite(property) ? property : null;
}
async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>): Promise<readonly R[]> {
  const results: R[] = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex; nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function validateConversationHistory(history: readonly AgentConversationMessage[]): readonly AgentConversationMessage[] {
  if (history.length > 20) throw new Error("Conversation history must contain at most 20 messages.");
  let characterCount = 0;
  return history.map((message): AgentConversationMessage => {
    if (message.role !== "user" && message.role !== "assistant") throw new Error("Conversation history contains an unsupported role.");
    const content = message.content.trim();
    if (content === "") throw new Error("Conversation history messages must not be empty.");
    characterCount += content.length;
    if (characterCount > 40_000) throw new Error("Conversation history exceeds the 40,000 character limit.");
    return { role: message.role, content };
  });
}

