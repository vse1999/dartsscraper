import { z } from "zod";
import type { ModusPlayersService } from "../modus/service.js";
import type { OfficialModusResultsService } from "../modus/results-service.js";
import type { PlayerMatchesService } from "../services/player-matches.js";
import { calculateMatchAverage } from "../services/statistics.js";
import { resolveResearchDate } from "./date.js";

const ResolveDateArgumentsSchema = z.object({ expression: z.string().trim().min(1) }).strict();
const ModusPlayersArgumentsSchema = z.object({ date: z.string().trim().min(1) }).strict();
const PlayerArgumentsSchema = z.object({ player: z.string().trim().min(1), limit: z.number().int().min(1).max(1000) }).strict();

export interface AgentToolCall { name: string; arguments: unknown; }
export type AgentToolErrorCode = "UNKNOWN_TOOL" | "INVALID_ARGUMENTS" | "TOOL_FAILED";
export type AgentToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: AgentToolErrorCode; message: string } };
export interface DartsAgentToolDependencies {
  modusService: Pick<ModusPlayersService, "getModusPlayers">;
  modusResultsService?: Pick<OfficialModusResultsService, "getResults">;
  playerMatchesService: Pick<PlayerMatchesService, "getLastMatches">;
  now?: () => Date;
  timeZone?: string;
}

export const AGENT_TOOL_DEFINITIONS: readonly Readonly<Record<string, unknown>>[] = [
  { type: "function", function: { name: "resolveDate", description: "Resolve an explicit or relative English/Hungarian date expression to an ISO date in Europe/Budapest.", parameters: { type: "object", additionalProperties: false, required: ["expression"], properties: { expression: { type: "string" } } } } },
  { type: "function", function: { name: "getModusPlayers", description: "Get the confirmed MODUS Super Series players scheduled on an ISO date.", parameters: { type: "object", additionalProperties: false, required: ["date"], properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } } } } },
  { type: "function", function: { name: "getModusResults", description: "Get the authoritative official MODUS Super Series daily matches, scores, per-match three-dart averages, and cumulative weekly player averages for an ISO date. Use this for current/latest MODUS results instead of DartsOrakel.", parameters: { type: "object", additionalProperties: false, required: ["date"], properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } } } } },
  { type: "function", function: { name: "getPlayerMatches", description: "Get a player's latest completed DartsOrakel matches.", parameters: { type: "object", additionalProperties: false, required: ["player", "limit"], properties: { player: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 } } } } },
  { type: "function", function: { name: "getPlayerMatchAverage", description: "Deterministically calculate a player's mean three-dart average over their latest completed matches.", parameters: { type: "object", additionalProperties: false, required: ["player", "limit"], properties: { player: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 } } } } },
];

export class DartsAgentToolExecutor {
  private readonly dependencies: DartsAgentToolDependencies;
  public constructor(dependencies: DartsAgentToolDependencies) { this.dependencies = dependencies; }
  public async execute(call: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult> {
    try {
      switch (call.name) {
        case "resolveDate": {
          const args = ResolveDateArgumentsSchema.parse(normalizeArguments(call.arguments));
          const now = this.dependencies.now?.();
          const dateOptions = { ...(now === undefined ? {} : { now }), ...(this.dependencies.timeZone === undefined ? {} : { timeZone: this.dependencies.timeZone }) };
          return { ok: true, data: resolveResearchDate(args.expression, dateOptions) };
        }
        case "getModusPlayers": {
          const args = ModusPlayersArgumentsSchema.parse(normalizeArguments(call.arguments));
          return { ok: true, data: await this.dependencies.modusService.getModusPlayers(args.date) };
        }
        case "getModusResults": {
          const args = ModusPlayersArgumentsSchema.parse(normalizeArguments(call.arguments));
          if (this.dependencies.modusResultsService === undefined) throw new Error("The official MODUS results service is not configured.");
          return { ok: true, data: await this.dependencies.modusResultsService.getResults(args.date, signal) };
        }
        case "getPlayerMatches": {
          const args = PlayerArgumentsSchema.parse(normalizeArguments(call.arguments));
          const result = await this.dependencies.playerMatchesService.getLastMatches(args.player, args.limit);
          return { ok: true, data: { ...result, meanMatchAverage: calculateMatchAverage(result.matches) } };
        }
        case "getPlayerMatchAverage": {
          const args = PlayerArgumentsSchema.parse(normalizeArguments(call.arguments));
          const result = await this.dependencies.playerMatchesService.getLastMatches(args.player, args.limit);
          return { ok: true, data: { player: result.player.name, requestedLimit: args.limit, matchCount: result.matches.length, average: calculateMatchAverage(result.matches) } };
        }
        default:
          return { ok: false, error: { code: "UNKNOWN_TOOL", message: `Tool ${JSON.stringify(call.name)} does not exist.` } };
      }
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return { ok: false, error: { code: "INVALID_ARGUMENTS", message: error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ") } };
      }
      return { ok: false, error: { code: "TOOL_FAILED", message: error instanceof Error ? error.message : "Unknown tool failure." } };
    }
  }
}

function normalizeArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { const parsed: unknown = JSON.parse(value); return parsed; }
  catch { return value; }
}


