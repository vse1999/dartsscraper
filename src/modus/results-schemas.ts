import { z } from "zod";

import { IsoDateSchema } from "../agent/date.js";

export const ModusIsoDateTimeSchema = z.string().datetime({ offset: true });

export const ModusResultsContextSchema = z
  .object({
    seriesId: z.string().trim().min(1),
    seriesName: z.string().trim().min(1),
    weekId: z.string().trim().min(1),
    weekName: z.string().trim().min(1),
    group: z.string().trim().min(1),
  })
  .strict();

const ModusMatchPlayerSchema = z
  .object({
    name: z.string().trim().min(1),
    score: z.number().int().nonnegative().nullable(),
    average: z.number().finite().nonnegative().nullable(),
  })
  .strict();

const ModusMatchSchema = z
  .object({
    id: z.string().trim().min(1),
    matchNumber: z.number().int().positive(),
    startTime: ModusIsoDateTimeSchema,
    status: z.enum(["scheduled", "live", "completed", "cancelled", "unknown"]),
    home: ModusMatchPlayerSchema,
    away: ModusMatchPlayerSchema,
  })
  .strict();

const ModusWeekAverageSchema = z
  .object({
    position: z.number().int().positive(),
    player: z.string().trim().min(1),
    played: z.number().int().nonnegative(),
    points: z.number().int(),
    darts: z.number().int().positive(),
    average: z.number().finite().nonnegative(),
  })
  .strict();

const ModusResultsSourceSchema = z
  .object({
    dailyFeedUrl: z.string().url(),
    resultsUrl: z.string().url(),
    weekAveragesUrl: z.string().url(),
  })
  .strict();

export const ModusResultsSnapshotSchema = z
  .object({
    event: z.literal("MODUS Super Series"),
    date: IsoDateSchema,
    generatedAt: ModusIsoDateTimeSchema,
    fetchedAt: ModusIsoDateTimeSchema,
    context: ModusResultsContextSchema,
    matches: z.array(ModusMatchSchema),
    weekAverages: z.array(ModusWeekAverageSchema),
    source: ModusResultsSourceSchema,
    warnings: z.array(z.string()),
  })
  .strict();

export type ModusResultsContext = z.infer<typeof ModusResultsContextSchema>;
export type ModusMatchPlayer = z.infer<typeof ModusMatchPlayerSchema>;
export type ModusMatch = z.infer<typeof ModusMatchSchema>;
export type ModusWeekAverage = z.infer<typeof ModusWeekAverageSchema>;
export type ModusResultsSource = z.infer<typeof ModusResultsSourceSchema>;
export type ModusResultsSnapshot = z.infer<typeof ModusResultsSnapshotSchema>;
