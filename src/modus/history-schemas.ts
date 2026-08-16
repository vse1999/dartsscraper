import { z } from "zod";

import { IsoDateSchema } from "../agent/date.js";

export const MODUS_RESULTS_URL = "https://modussuperseries.com/results.php";
export const MODUS_MATCH_DETAILS_URL = "https://modussuperseries.com/match-db-stats.php";
export const MODUS_RESULT_GROUPS = ["Group A", "Group B", "Group C", "Final"] as const;

export const ModusResultGroupSchema = z.enum(MODUS_RESULT_GROUPS);

const ModusWeekDescriptorSchema = z.object({
  id: z.string().regex(/^\d+$/u),
  name: z.string().trim().min(1),
  order: z.number().int().nonnegative(),
}).strict();

const ModusSeriesDescriptorSchema = z.object({
  id: z.string().regex(/^\d+$/u),
  name: z.string().trim().min(1),
  order: z.number().int().nonnegative(),
  weeks: z.array(ModusWeekDescriptorSchema),
}).strict();

export const ModusMatchReferenceSchema = z.object({
  matchId: z.string().regex(/^\d+$/u),
  seriesId: z.string().regex(/^\d+$/u),
  seriesName: z.string().trim().min(1),
  seriesOrder: z.number().int().nonnegative(),
  weekId: z.string().regex(/^\d+$/u),
  weekName: z.string().trim().min(1),
  weekOrder: z.number().int().nonnegative(),
  group: ModusResultGroupSchema,
  matchNumber: z.number().int().positive(),
  homeName: z.string().trim().min(1),
  awayName: z.string().trim().min(1),
}).strict();

export const ModusResultsIndexSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  sourceUrl: z.literal(MODUS_RESULTS_URL),
  series: z.array(ModusSeriesDescriptorSchema),
  matches: z.array(ModusMatchReferenceSchema),
}).strict();

const ModusMatchSideSchema = z.object({
  name: z.string().trim().min(1),
  score: z.number().int().nonnegative(),
  average: z.number().finite().nonnegative(),
}).strict();

export const ModusHistoricalMatchSchema = z.object({
  matchId: z.string().regex(/^\d+$/u),
  playedAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u),
  date: IsoDateSchema,
  seriesName: z.string().trim().min(1),
  weekName: z.string().trim().min(1),
  group: z.string().trim().min(1),
  home: ModusMatchSideSchema,
  away: ModusMatchSideSchema,
  sourceUrl: z.string().url(),
}).strict();

export type ModusResultGroup = z.infer<typeof ModusResultGroupSchema>;
export type ModusWeekDescriptor = z.infer<typeof ModusWeekDescriptorSchema>;
export type ModusSeriesDescriptor = z.infer<typeof ModusSeriesDescriptorSchema>;
export type ModusMatchReference = z.infer<typeof ModusMatchReferenceSchema>;
export type ModusResultsIndex = z.infer<typeof ModusResultsIndexSchema>;
export type ModusHistoricalMatch = z.infer<typeof ModusHistoricalMatchSchema>;
