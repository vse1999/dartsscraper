import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";

import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "../agent/config.js";
import { createDartsResearchRuntime } from "../agent/factory.js";
import type { AgentConversationMessage, AgentRunOptions, AgentRunResult } from "../agent/harness.js";
import { AgentLimitError, OllamaRequestError } from "../errors.js";
import { ConsoleLogger, type Logger } from "../logger.js";
import type { FastResearchAnswer } from "../services/fast-research.js";
import { createOllamaHealthChecker, type OllamaHealthChecker, type OllamaHealthResult } from "./ollama-health.js";
import { ChatSessionStore } from "./session-store.js";

const ChatRequestSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().trim().min(1).max(4_000),
}).strict();
const SessionIdSchema = z.string().uuid();

const STATIC_FILES: Readonly<Record<string, { file: string; contentType: string }>> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
};

interface ChatAgent {
  run(query: string, options?: AgentRunOptions): Promise<AgentRunResult>;
}

export interface FastChatService {
  initialize(): Promise<void>;
  tryAnswer(query: string, history?: readonly AgentConversationMessage[], signal?: AbortSignal): Promise<FastResearchAnswer | null>;
  close(): void;
}

export interface ChatServerOptions {
  agent?: ChatAgent;
  fastResearchService?: FastChatService;
  sessionStore?: ChatSessionStore;
  healthChecker?: OllamaHealthChecker;
  model?: string;
  ollamaBaseUrl?: string;
  ollamaKeepAlive?: string;
  staticDirectory?: string;
  maxBodyBytes?: number;
  maxConcurrentChats?: number;
  logger?: Logger;
}

export interface StartChatServerOptions extends ChatServerOptions {
  host?: string;
  port?: number;
}

export interface StartedChatServer {
  server: Server;
  host: string;
  port: number;
  url: string;
}

export function createChatServer(options: ChatServerOptions = {}): Server {
  const dependencies = resolveChatDependencies(options);
  if (dependencies.fastResearchService !== undefined) {
    void dependencies.fastResearchService.initialize().catch((error: unknown) => {
      dependencies.logger.warn("Fast-path startup preload failed; requests will retry on demand.", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
  }
  return createResolvedChatServer(options, dependencies);
}

export async function startChatServer(options: StartChatServerOptions = {}): Promise<StartedChatServer> {
  const host = options.host ?? "127.0.0.1";
  const port = validPort(options.port ?? 3_210);
  const dependencies = resolveChatDependencies(options);
  await dependencies.fastResearchService?.initialize();
  const server = createResolvedChatServer(options, dependencies);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const browserHost = host.includes(":") ? `[${host}]` : host;
  return { server, host, port: actualPort, url: `http://${browserHost}:${actualPort}` };
}

interface ResolvedChatDependencies {
  agent: ChatAgent;
  fastResearchService: FastChatService | undefined;
  logger: Logger;
  model: string;
  ollamaBaseUrl: string;
}

function resolveChatDependencies(options: ChatServerOptions): ResolvedChatDependencies {
  const model = options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const ollamaBaseUrl = options.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const logger = options.logger ?? new ConsoleLogger({ minimumLevel: "info" });
  if (options.agent !== undefined) {
    return { agent: options.agent, fastResearchService: options.fastResearchService, logger, model, ollamaBaseUrl };
  }
  const runtime = createDartsResearchRuntime({
    model,
    ollamaBaseUrl,
    ...(options.ollamaKeepAlive === undefined ? {} : { ollamaKeepAlive: options.ollamaKeepAlive }),
  });
  return {
    agent: runtime.agent,
    fastResearchService: options.fastResearchService ?? runtime.fastResearchService,
    logger,
    model,
    ollamaBaseUrl,
  };
}

function createResolvedChatServer(options: ChatServerOptions, dependencies: ResolvedChatDependencies): Server {
  const sessions = options.sessionStore ?? new ChatSessionStore();
  const health = options.healthChecker ?? createOllamaHealthChecker({ model: dependencies.model, baseUrl: dependencies.ollamaBaseUrl });
  const staticDirectory = options.staticDirectory ?? path.resolve(process.cwd(), "public");
  const maxBodyBytes = positiveInteger(options.maxBodyBytes ?? 16_384, "maxBodyBytes");
  const chatGate = new RequestGate(positiveInteger(options.maxConcurrentChats ?? 1, "maxConcurrentChats"));

  const server = createServer((request, response) => {
    applySecurityHeaders(response);
    void routeRequest({
      request,
      response,
      agent: dependencies.agent,
      fastResearchService: dependencies.fastResearchService,
      sessions,
      health,
      staticDirectory,
      maxBodyBytes,
      chatGate,
      logger: dependencies.logger,
      model: dependencies.model,
    });
  });
  server.once("close", () => dependencies.fastResearchService?.close());
  return server;
}

async function routeRequest(context: {
  request: IncomingMessage;
  response: ServerResponse;
  agent: ChatAgent;
  fastResearchService: FastChatService | undefined;
  sessions: ChatSessionStore;
  health: OllamaHealthChecker;
  staticDirectory: string;
  maxBodyBytes: number;
  chatGate: RequestGate;
  logger: Logger;
  model: string;
}): Promise<void> {
  const { request, response } = context;
  try {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
    if (!isSameOriginRequest(request)) throw new HttpError(403, "Cross-origin requests are not allowed.");

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      const result = await context.health.check();
      writeJson(response, result.status === "ready" ? 200 : 503, {
        ...result,
        fastPathReady: context.fastResearchService !== undefined,
      });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/chat") {
      await handleChat(context);
      return;
    }
    if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/sessions/")) {
      const sessionId = decodeURIComponent(requestUrl.pathname.slice("/api/sessions/".length));
      const parsedSessionId = SessionIdSchema.safeParse(sessionId);
      if (!parsedSessionId.success) throw new HttpError(400, "A valid session ID is required.");
      context.sessions.delete(parsedSessionId.data);
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      await serveStaticFile(response, request.method, requestUrl.pathname, context.staticDirectory);
      return;
    }
    response.setHeader("Allow", "GET, HEAD, POST, DELETE");
    throw new HttpError(405, "Method not allowed.");
  } catch (error: unknown) {
    handleRouteError(error, response, context.logger);
  }
}

async function handleChat(context: {
  request: IncomingMessage;
  response: ServerResponse;
  agent: ChatAgent;
  fastResearchService: FastChatService | undefined;
  sessions: ChatSessionStore;
  health: OllamaHealthChecker;
  maxBodyBytes: number;
  chatGate: RequestGate;
  model: string;
}): Promise<void> {
  const contentType = context.request.headers["content-type"]?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US");
  if (contentType !== "application/json") throw new HttpError(415, "Content-Type must be application/json.");
  const body = await readJsonBody(context.request, context.maxBodyBytes);
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid chat request.");
  const history = context.sessions.getHistory(parsed.data.sessionId);
  const abortController = new AbortController();
  const onAborted = (): void => abortController.abort(new Error("Browser disconnected."));
  const onResponseClosed = (): void => {
    if (!context.response.writableEnded) abortController.abort(new Error("Browser disconnected."));
  };
  context.request.once("aborted", onAborted);
  context.response.once("close", onResponseClosed);
  try {
    const fastAnswer = await tryFastAnswer(context.fastResearchService, parsed.data.message, history, abortController.signal);
    if (fastAnswer !== null) {
      context.sessions.appendExchange(parsed.data.sessionId, parsed.data.message, fastAnswer.answer);
      writeJson(context.response, 200, {
        sessionId: parsed.data.sessionId,
        answer: fastAnswer.answer,
        model: context.model,
        executionMode: fastAnswer.executionMode,
        sourceLatencyMs: fastAnswer.sourceLatencyMs,
        dataAgeMs: fastAnswer.dataAgeMs,
        fetchedAt: fastAnswer.fetchedAt,
        stale: fastAnswer.stale,
        metrics: { iterations: 0, toolCalls: 0 },
      });
      return;
    }

    const release = context.chatGate.tryAcquire();
    if (release === undefined) throw new HttpError(429, "The local model is busy. Please wait for the current answer to finish.");
    try {
      const health = await context.health.check();
      if (health.status !== "ready") throw healthError(health);
      const result = await context.agent.run(parsed.data.message, { history, signal: abortController.signal });
      context.sessions.appendExchange(parsed.data.sessionId, parsed.data.message, result.answer);
      writeJson(context.response, 200, {
        sessionId: parsed.data.sessionId,
        answer: result.answer,
        model: result.model,
        executionMode: "llm",
        metrics: { iterations: result.iterations, toolCalls: result.toolCalls },
      });
    } finally {
      release();
    }
  } finally {
    context.request.removeListener("aborted", onAborted);
    context.response.removeListener("close", onResponseClosed);
  }
}

async function tryFastAnswer(
  service: FastChatService | undefined,
  query: string,
  history: readonly AgentConversationMessage[],
  signal: AbortSignal,
): Promise<FastResearchAnswer | null> {
  if (service === undefined) return null;
  try {
    return await service.tryAnswer(query, history, signal);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.slice(0, 500) : "unknown source error";
    throw new HttpError(502, `The live darts source could not provide safe current data: ${detail}`);
  }
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const declaredLength = declaredBodyLength(request);
    if (declaredLength !== undefined && declaredLength > maxBodyBytes) {
      request.resume();
      reject(new HttpError(413, `Request body exceeds ${maxBodyBytes} bytes.`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > maxBodyBytes) {
        fail(new HttpError(413, `Request body exceeds ${maxBodyBytes} bytes.`));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new HttpError(400, "Request body must contain valid JSON."));
      }
    };
    const onError = (error: Error): void => fail(new HttpError(400, `Unable to read request body: ${error.message}`));
    const onAborted = (): void => fail(new HttpError(400, "Request was aborted before the body completed."));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function declaredBodyLength(request: IncomingMessage): number | undefined {
  const header = request.headers["content-length"];
  if (typeof header !== "string") return undefined;
  const length = Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

async function serveStaticFile(response: ServerResponse, method: string, pathname: string, staticDirectory: string): Promise<void> {
  const definition = STATIC_FILES[pathname];
  if (definition === undefined) throw new HttpError(404, "Not found.");
  const filePath = path.join(staticDirectory, definition.file);
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    throw new HttpError(404, "Chat interface asset not found. Run the app from the project directory.");
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", definition.contentType);
  response.setHeader("Content-Length", fileStats.size);
  response.setHeader("Cache-Control", "no-cache");
  if (method === "HEAD") {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

function isSameOriginRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function handleRouteError(error: unknown, response: ServerResponse, logger: Logger): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof HttpError) {
    writeJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof OllamaRequestError) {
    logger.error("Ollama chat request failed.", { status: error.status, error: error.message });
    writeJson(response, 502, { error: "Ollama could not complete the request. Check that Ollama is running and try again." });
    return;
  }
  if (error instanceof AgentLimitError) {
    logger.warn("Agent request reached a safety limit.", { error: error.message });
    writeJson(response, 504, { error: error.message });
    return;
  }
  logger.error("Unexpected chat server error.", { error: error instanceof Error ? error.message : "unknown error" });
  writeJson(response, 500, { error: "The chatbot encountered an unexpected local error." });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function healthError(health: OllamaHealthResult): HttpError {
  return new HttpError(503, health.message);
}

class HttpError extends Error {
  public readonly status: number;
  public constructor(status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

class RequestGate {
  private active = 0;
  public constructor(private readonly limit: number) {}
  public tryAcquire(): (() => void) | undefined {
    if (this.active >= this.limit) return undefined;
    this.active += 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("Chat port must be an integer from 0 to 65535.");
  return value;
}

export type { ChatAgent };
