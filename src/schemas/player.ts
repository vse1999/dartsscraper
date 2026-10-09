import { z } from "zod";
import { load } from "cheerio";

export const PlayerIdentitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});

export type PlayerIdentity = z.infer<typeof PlayerIdentitySchema>;

const PlayerStatsRowSchema = z.object({
  player_key: z.number().int().positive(),
  // The JSON directory contains HTML entities (e.g. O&#039;Connor). Decode
  // once at the provider boundary so every resolver shares the same identity.
  player_name: z.string().trim().min(1).transform((value: string): string => {
    if (!/[<&]/u.test(value)) return value.replace(/\s+/gu, " ").trim();
    const $ = load(value, {}, false);
    $("script, style").remove();
    return $.root().text().replace(/\s+/gu, " ").trim();
  }).pipe(z.string().min(1)),
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
