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

export const ModusFixtureSchema = z.object({
  id: z.string().trim().min(1),
  event: z.literal("MODUS Super Series"),
  date: IsoDateSchema,
  startTime: z.string().datetime({ offset: true }).nullable(),
  playerOne: z.string().trim().min(1),
  playerTwo: z.string().trim().min(1),
  source: z.string().url(),
}).strict().superRefine((fixture, context) => {
  if (fixture.playerOne.normalize("NFKC").toLocaleLowerCase("en-US")
    === fixture.playerTwo.normalize("NFKC").toLocaleLowerCase("en-US")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A MODUS fixture must contain two different players.",
      path: ["playerTwo"],
    });
  }
});

export const ModusFixturesResultSchema = z.object({
  event: z.literal("MODUS Super Series"),
  date: IsoDateSchema,
  fixtures: z.array(ModusFixtureSchema),
}).strict();

export type ModusFixture = z.infer<typeof ModusFixtureSchema>;
export type ModusFixturesResult = z.infer<typeof ModusFixturesResultSchema>;

export interface ModusFixtureSource {
  readonly name: string;
  getPlayers(date: string): Promise<readonly string[]>;
  getFixtures?(date: string): Promise<readonly ModusFixture[]>;
  sourceUrl(date: string): string;
}
