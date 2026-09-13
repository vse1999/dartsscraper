import { z } from "zod";

import { IsoDateSchema } from "../agent/date.js";

export const PDC_CALENDAR_CATEGORIES = ["All Rankings", "TV Ranking", "TV", "PDCE"] as const;
export const PdcCalendarCategorySchema = z.enum(PDC_CALENDAR_CATEGORIES);
export type PdcCalendarCategory = z.infer<typeof PdcCalendarCategorySchema>;

export const PDC_TOURNAMENT_NAMES = [
  "European Championship",
  "European Tour",
  "Grand Slam",
  "Grand Slam of Darts",
  "Masters",
  "PDC World Championship",
  "Players Championship",
  "Players Championship Finals",
  "Premier League",
  "UK Open",
  "World Championship",
  "World Darts Championship",
  "World Cup",
  "World Grand Prix",
  "World Matchplay",
  "World Series of Darts",
  "World Series of Darts Finals",
  "World Series Finals",
] as const;

const PdcTournamentNameSchema = z.enum(PDC_TOURNAMENT_NAMES);

export const PdcTournamentEventSchema = z.object({
  eventKey: z.number().int().positive(),
  tournamentKey: z.number().int().positive(),
  tournamentName: PdcTournamentNameSchema,
  tournamentNumber: z.number().int().nonnegative(),
  category: z.string().trim().min(1),
  eventDate: IsoDateSchema,
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  eventAverage: z.number().finite().nonnegative().nullable(),
  winnerAverage: z.number().finite().nonnegative().nullable(),
  winnerName: z.string().trim().min(1).nullable(),
  winnerPlayerId: z.number().int().positive().nullable(),
  calendarUrl: z.string().url(),
  resultsUrl: z.string().url(),
}).strict().superRefine((event, context) => {
  if (event.startDate > event.endDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "startDate must not be later than endDate.", path: ["startDate"] });
  }
});

export type PdcTournamentEvent = z.infer<typeof PdcTournamentEventSchema>;

export const PdcTournamentMatchSchema = z.object({
  matchId: z.number().int().positive(),
  round: z.string().trim().min(1).nullable(),
  winnerName: z.string().trim().min(1),
  winnerPlayerId: z.number().int().positive(),
  loserName: z.string().trim().min(1),
  loserPlayerId: z.number().int().positive(),
  winnerScore: z.number().int().nonnegative(),
  loserScore: z.number().int().nonnegative(),
  sourceUrl: z.string().url(),
}).strict();

export type PdcTournamentMatch = z.infer<typeof PdcTournamentMatchSchema>;

export const PdcTournamentResultSchema = z.object({
  event: PdcTournamentEventSchema,
  matches: z.array(PdcTournamentMatchSchema).min(1),
  sourceUrl: z.string().url(),
}).strict();

export type PdcTournamentResult = z.infer<typeof PdcTournamentResultSchema>;

export interface PdcTournamentSource {
  getCalendar(year: number, category: PdcCalendarCategory): Promise<readonly PdcTournamentEvent[]>;
  getResults(event: PdcTournamentEvent): Promise<PdcTournamentResult>;
}
