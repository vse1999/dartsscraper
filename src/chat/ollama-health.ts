import { z } from "zod";

import { DEFAULT_OLLAMA_BASE_URL } from "../agent/config.js";

const OllamaModelsSchema = z.object({
  models: z.array(z.object({ name: z.string().optional(), model: z.string().optional() })),
});
const OllamaVersionSchema = z.object({ version: z.string().min(1) });

export type OllamaHealthStatus = "ready" | "model_missing" | "unavailable";

export interface OllamaHealthResult {
  status: OllamaHealthStatus;
  model: string;
  message: string;
  ollamaVersion?: string;
}

export interface OllamaHealthCheckerOptions {
  baseUrl?: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
}

export interface OllamaHealthChecker {
  check(): Promise<OllamaHealthResult>;
}

export function createOllamaHealthChecker(options: OllamaHealthCheckerOptions): OllamaHealthChecker {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? 5_000, "timeoutMs");
  const cacheMs = nonNegativeInteger(options.cacheMs ?? 5_000, "cacheMs");
  const now = options.now ?? Date.now;
  let cached: { result: OllamaHealthResult; expiresAt: number } | undefined;

  return {
    check: async (): Promise<OllamaHealthResult> => {
      const currentTime = now();
      if (cached !== undefined && cached.expiresAt > currentTime) return cached.result;
      const result = await checkOllama({ baseUrl, model: options.model, fetchImpl, timeoutMs });
      cached = { result, expiresAt: currentTime + cacheMs };
      return result;
    },
  };
}

async function checkOllama(input: {
  baseUrl: string;
  model: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<OllamaHealthResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Ollama health check timed out.")), input.timeoutMs);
  try {
    const [modelsResponse, versionResponse] = await Promise.all([
      input.fetchImpl(`${input.baseUrl}/api/tags`, { headers: { Accept: "application/json" }, signal: controller.signal }),
      input.fetchImpl(`${input.baseUrl}/api/version`, { headers: { Accept: "application/json" }, signal: controller.signal }),
    ]);
    if (!modelsResponse.ok || !versionResponse.ok) {
      return unavailable(input.model, `Ollama health check failed with HTTP ${!modelsResponse.ok ? modelsResponse.status : versionResponse.status}.`);
    }
    const modelsPayload: unknown = await modelsResponse.json();
    const versionPayload: unknown = await versionResponse.json();
    const models = OllamaModelsSchema.safeParse(modelsPayload);
    const version = OllamaVersionSchema.safeParse(versionPayload);
    if (!models.success || !version.success) return unavailable(input.model, "Ollama returned an unexpected health response.");
    const installed = models.data.models.some((candidate) => candidate.name === input.model || candidate.model === input.model);
    if (!installed) {
      return {
        status: "model_missing",
        model: input.model,
        ollamaVersion: version.data.version,
        message: `Model ${input.model} is not installed. Run: ollama pull ${input.model}`,
      };
    }
    return { status: "ready", model: input.model, ollamaVersion: version.data.version, message: "Ollama and the configured model are ready." };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown connection error";
    return unavailable(input.model, `Cannot reach Ollama at ${input.baseUrl}: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

function unavailable(model: string, message: string): OllamaHealthResult {
  return { status: "unavailable", model, message };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Ollama base URL must use HTTP or HTTPS.");
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}
