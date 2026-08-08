import { z } from "zod";
import { IsoDateSchema } from "../agent/date.js";

export const ModusPlayerSchema = z.object({
  name: z.string().trim().min(1),
  source: z.string().url(),
  confidence: z.literal(1),
});
export const ModusPlayersResultSchema = z.object({
  event: z.literal("MODUS Super Series"),
  date: IsoDateSchema,
  players: z.array(ModusPlayerSchema),
});
export type ModusPlayer = z.infer<typeof ModusPlayerSchema>;
export type ModusPlayersResult = z.infer<typeof ModusPlayersResultSchema>;
export interface ModusFixtureSource {
  readonly name: string;
  getPlayers(date: string): Promise<readonly string[]>;
  sourceUrl(date: string): string;
}
