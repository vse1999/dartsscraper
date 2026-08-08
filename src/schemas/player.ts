import { z } from "zod";

export const PlayerIdentitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});

export type PlayerIdentity = z.infer<typeof PlayerIdentitySchema>;

const PlayerStatsRowSchema = z.object({
  player_key: z.number().int().positive(),
  player_name: z.string().trim().min(1),
  player_profile_url: z.string().url(),
});

export const PlayerStatsResponseSchema = z.object({
  draw: z.number().int().nonnegative(),
  recordsTotal: z.number().int().nonnegative(),
  recordsFiltered: z.number().int().nonnegative(),
  data: z.array(PlayerStatsRowSchema),
});

export type PlayerStatsResponse = z.infer<typeof PlayerStatsResponseSchema>;
export type PlayerStatsRow = z.infer<typeof PlayerStatsRowSchema>;
