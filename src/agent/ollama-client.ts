import { z } from "zod";
import { OllamaRequestError } from "../errors.js";
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_KEEP_ALIVE } from "./config.js";

const ToolCallSchema = z.object({ function: z.object({ name: z.string().min(1), arguments: z.unknown() }) });
const ChatResponseSchema = z.object({ message: z.object({ role: z.literal("assistant"), content: z.string().default(""), tool_calls: z.array(ToolCallSchema).optional() }) });
const JsonProtocolResponseSchema = z.object({
  action: z.enum(["tools", "final"]),
  calls: z.array(z.object({ name: z.string().min(1), arguments: z.record(z.unknown()) })).optional(),
  answer: z.string().optional(),
}).superRefine((value, context) => {
  if (value.action === "tools" && (value.calls === undefined || value.calls.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Tool action requires at least one call." });
  if (value.action === "final" && (value.answer === undefined || value.answer.trim() === "")) context.addIssue({ code: z.ZodIssueCode.custom, message: "Final action requires an answer." });
});
const JSON_PROTOCOL_FORMAT = {
  type: "object", additionalProperties: false, required: ["action", "calls", "answer"],
  properties: {
    action: { type: "string", enum: ["tools", "final"], description: "Use tools until all data is collected; then use final." },
    calls: { type: "array", description: "All independent calls should be emitted together. Use an empty array for final.", items: { type: "object", additionalProperties: false, required: ["name", "arguments"], properties: { name: { type: "string" }, arguments: { type: "object" } } } },
    answer: { type: "string", description: "A non-empty user-facing answer for final; empty string for tools." },
  },
} as const;

export interface OllamaToolCall { function: { name: string; arguments: unknown } }
export interface OllamaMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: readonly OllamaToolCall[]; tool_name?: string; }
export interface OllamaChatRequest { model: string; messages: readonly OllamaMessage[]; tools: readonly Readonly<Record<string, unknown>>[]; }
export interface OllamaChatResponse { message: OllamaMessage; }
export interface OllamaChatClient { chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResponse>; }
export interface OllamaClientOptions { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number; keepAlive?: string; }
type ToolMode = "unknown" | "native" | "json-protocol";

export class OllamaClient implements OllamaChatClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly keepAlive: string;
  private toolMode: ToolMode = "unknown";
  public constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Ollama timeoutMs must be a positive finite number.");
    this.keepAlive = validateKeepAlive(options.keepAlive ?? DEFAULT_OLLAMA_KEEP_ALIVE);
  }
  public async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResponse> {
    if (this.toolMode === "json-protocol") return this.chatWithJsonProtocol(request, signal);
    const native = await this.request({ ...request, stream: false, think: false, keep_alive: this.keepAlive, options: { temperature: 0 } }, signal, true);
    if (native.status === 400 && native.text.toLocaleLowerCase("en-US").includes("does not support tools")) {
      this.toolMode = "json-protocol";
      return this.chatWithJsonProtocol(request, signal);
    }
    if (!native.ok) throw requestError(native.status, native.text);
    this.toolMode = "native";
    return parseNativeResponse(native.text);
  }
  private async chatWithJsonProtocol(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResponse> {
    const messages = jsonProtocolMessages(request);
    const result = await this.request({ model: request.model, messages, stream: false, think: false, keep_alive: this.keepAlive, format: JSON_PROTOCOL_FORMAT, options: { temperature: 0 } }, signal, false);
    if (!result.ok) throw requestError(result.status, result.text);
    let payload: unknown;
    try { payload = JSON.parse(result.text) as unknown; }
    catch (error: unknown) { throw new OllamaRequestError("Ollama returned invalid JSON.", result.status, { cause: error }); }
    const response = ChatResponseSchema.safeParse(payload);
    if (!response.success) throw new OllamaRequestError(`Ollama returned a malformed chat response: ${response.error.issues[0]?.message ?? "schema mismatch"}.`);
    let content: unknown;
    try { content = JSON.parse(response.data.message.content) as unknown; }
    catch (error: unknown) { throw new OllamaRequestError("Gemma returned an invalid JSON agent action.", undefined, { cause: error }); }
    const action = JsonProtocolResponseSchema.safeParse(content);
    if (!action.success) throw new OllamaRequestError(`Gemma returned a malformed agent action: ${action.error.issues[0]?.message ?? "schema mismatch"}.`);
    if (action.data.action === "final") return { message: { role: "assistant", content: action.data.answer ?? "" } };
    return { message: { role: "assistant", content: "", tool_calls: (action.data.calls ?? []).map((call) => ({ function: call })) } };
  }
  private async request(body: unknown, signal: AbortSignal | undefined, allowUnsupportedTools: boolean): Promise<{ ok: boolean; status: number; text: string }> {
    if (signal?.aborted === true) {
      throw new OllamaRequestError("Ollama request was cancelled.", undefined, { cause: signal.reason });
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Ollama request timed out.")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok && !(allowUnsupportedTools && response.status === 400)) throw requestError(response.status, text);
      return { ok: response.ok, status: response.status, text };
    } catch (error: unknown) {
      if (error instanceof OllamaRequestError) throw error;
      throw new OllamaRequestError(`Unable to contact Ollama at ${this.baseUrl}: ${error instanceof Error ? error.message : "unknown error"}.`, undefined, { cause: error });
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }
}

function parseNativeResponse(text: string): OllamaChatResponse {
  let payload: unknown;
  try { payload = JSON.parse(text) as unknown; }
  catch (error: unknown) { throw new OllamaRequestError("Ollama returned invalid JSON.", undefined, { cause: error }); }
  const parsed = ChatResponseSchema.safeParse(payload);
  if (!parsed.success) throw new OllamaRequestError(`Ollama returned a malformed chat response: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`);
  const parsedMessage = parsed.data.message;
  const toolCalls = parsedMessage.tool_calls?.map((call) => ({ function: { name: call.function.name, arguments: call.function.arguments } }));
  return { message: { role: "assistant", content: parsedMessage.content, ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }) } };
}
function jsonProtocolMessages(request: OllamaChatRequest): readonly Readonly<Record<string, unknown>>[] {
  const protocol = [
    "This model uses a strict JSON tool protocol. Return action=tools with one or more calls when data is needed; return action=final only after all required tool results are present.",
    "Never put prose outside the JSON object. Never fabricate tool results. For action=tools set answer to an empty string. For action=final set calls to [] and answer to a complete non-empty response in the user's language. Put ALL independent player calls into one calls array. Available tools:",
    JSON.stringify(request.tools),
  ].join("\n");
  return request.messages.map((message) => {
    if (message.role === "system") return { role: "system", content: `${message.content}\n${protocol}` };
    if (message.role === "tool") return { role: "user", content: `TOOL RESULT (${message.tool_name ?? "unknown"}): ${message.content}` };
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      return { role: "assistant", content: JSON.stringify({ action: "tools", calls: message.tool_calls.map((call) => ({ name: call.function.name, arguments: call.function.arguments })) }) };
    }
    return { role: message.role, content: message.content };
  });
}
function requestError(status: number, text: string): OllamaRequestError {
  const detail = safeErrorDetail(text);
  return new OllamaRequestError(`Ollama request failed with HTTP ${status}${detail === "" ? "." : `: ${detail}`}`, status);
}
function safeErrorDetail(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") return value.error.slice(0, 500);
  } catch { return text.trim().slice(0, 500); }
  return text.trim().slice(0, 500);
}
function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Ollama base URL must use HTTP or HTTPS.");
  return url.toString().replace(/\/$/, "");
}

function validateKeepAlive(value: string): string {
  const normalized = value.trim();
  if (!/^(?:-1|0|\d+(?:ms|s|m|h))$/u.test(normalized)) {
    throw new Error("Ollama keepAlive must be 0, -1, or a duration such as 30m or 2h.");
  }
  return normalized;
}


