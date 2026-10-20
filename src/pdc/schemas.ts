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

export const PdcFixtureSchema = z.object({
  id: z.string().trim().min(1),
  tournamentName: z.string().trim().min(1),
  date: IsoDateSchema,
  startTime: z.string().datetime({ offset: true }).nullable(),
  session: z.string().trim().min(1).nullable(),
  round: z.string().trim().min(1).nullable(),
  playerOne: z.string().trim().min(1),
  playerTwo: z.string().trim().min(1),
  sourceUrl: z.string().url(),
  evidenceUrls: z.array(z.string().url()).min(1).optional(),
}).strict().superRefine((fixture, context) => {
  if (fixture.playerOne.normalize("NFKC").toLocaleLowerCase("en-US")
    === fixture.playerTwo.normalize("NFKC").toLocaleLowerCase("en-US")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A PDC fixture must contain two different players.",
      path: ["playerTwo"],
    });
  }
});

export type PdcFixture = z.infer<typeof PdcFixtureSchema>;

export const PdcEventCoverageSchema = z.enum(["available", "partial", "opponents_pending", "unavailable"]);
export type PdcEventCoverage = z.infer<typeof PdcEventCoverageSchema>;

export const PdcScheduleEventSchema = z.object({
  eventId: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  coverage: PdcEventCoverageSchema,
  fixtures: z.array(PdcFixtureSchema).max(128),
  pendingSlots: z.number().int().nonnegative().nullable(),
  reason: z.enum(["event_unavailable", "no_dated_fixtures", "opponents_unassigned", "fallback_only"]).nullable(),
  evidenceUrls: z.array(z.string().url()).max(10),
}).strict().superRefine((event, context): void => {
  if (event.coverage === "available" && event.fixtures.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An available event must contain a validated named fixture." });
  }
  if (event.coverage === "opponents_pending" && (event.pendingSlots === null || event.pendingSlots === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pending opponents require an explicit positive slot count." });
  }
  if (event.coverage === "unavailable" && event.fixtures.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Events with verified fixtures and a gap must be marked partial." });
  }
});

export type PdcScheduleEvent = z.infer<typeof PdcScheduleEventSchema>;

export const PdcScheduleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  date: IsoDateSchema,
  timeZone: z.literal("Europe/Budapest"),
  observedAt: z.string().datetime({ offset: true }),
  calendarStatus: z.enum(["verified", "unavailable"]),
  calendarReason: z.enum(["calendar_unavailable"]).nullable(),
  events: z.array(PdcScheduleEventSchema).max(64),
}).strict().superRefine((snapshot, context): void => {
  const eventIds = snapshot.events.map((event) => event.eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A PDC schedule cannot repeat an event identity." });
  }
  const fixtures = snapshot.events.flatMap((event) => event.fixtures);
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A PDC schedule cannot repeat a fixture identity." });
  }
  if (fixtures.some((fixture) => fixture.date !== snapshot.date)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Schedule fixtures must use the snapshot date." });
  }
  if (snapshot.calendarStatus === "verified" && snapshot.calendarReason !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A verified calendar cannot have an unavailable reason." });
  }
  if (snapshot.calendarStatus === "unavailable" && snapshot.calendarReason === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An unavailable calendar must state its bounded reason." });
  }
});

export type PdcScheduleSnapshot = z.infer<typeof PdcScheduleSnapshotSchema>;

export interface PdcTournamentSource {
  getCalendar(year: number, category: PdcCalendarCategory, signal?: AbortSignal): Promise<readonly PdcTournamentEvent[]>;
  getResults(event: PdcTournamentEvent, signal?: AbortSignal): Promise<PdcTournamentResult>;
}

export interface PdcFixtureSource {
  readonly name: string;
  getFixtures(date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]>;
  getSchedule?(date: string, signal?: AbortSignal): Promise<PdcScheduleSnapshot>;
}
