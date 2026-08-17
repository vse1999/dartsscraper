import { z } from "zod";

export const MAX_THREE_DART_AVERAGE = 180;

export const MatchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tournament: z.string().trim().min(1),
  round: z.string().trim().min(1).nullable(),
  result: z.string().trim().min(1),
  opponent: z.string().trim().min(1),
  score: z.string().trim().min(1),
  average: z.number().finite().nonnegative().max(MAX_THREE_DART_AVERAGE).nullable(),
});

export type Match = z.infer<typeof MatchSchema>;

export const MatchResultSchema = z.object({
  player: z.object({
    name: z.string().trim().min(1),
    id: z.number().int().positive(),
    slug: z.string().trim().min(1),
  }),
  matches: z.array(MatchSchema),
});

export type MatchResult = z.infer<typeof MatchResultSchema>;
