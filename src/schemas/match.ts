import { z } from "zod";

export const MAX_THREE_DART_AVERAGE = 180;
export const MAX_CHECKOUT_PERCENTAGE = 100;

export const MatchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tournament: z.string().trim().min(1),
  round: z.string().trim().min(1).nullable(),
  result: z.string().trim().min(1),
  opponent: z.string().trim().min(1),
  score: z.string().trim().min(1),
  average: z.number().finite().nonnegative().max(MAX_THREE_DART_AVERAGE).nullable(),
  // Optional keeps non-DartsOrakel Match producers source compatible.
  // Enriched DartsOrakel matches always set all four fields explicitly.
  oneEighties: z.number().int().nonnegative().nullable().optional(),
  checkoutPercentage: z.number().finite().nonnegative().max(MAX_CHECKOUT_PERCENTAGE).nullable().optional(),
  checkoutHits: z.number().int().nonnegative().nullable().optional(),
  checkoutAttempts: z.number().int().nonnegative().nullable().optional(),
}).superRefine((match, context) => {
  const hits = match.checkoutHits;
  const attempts = match.checkoutAttempts;
  const hitsAvailable = hits !== null && hits !== undefined;
  const attemptsAvailable = attempts !== null && attempts !== undefined;
  if (hitsAvailable !== attemptsAvailable) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "checkoutHits and checkoutAttempts must both be present or both be unavailable.",
      path: ["checkoutAttempts"],
    });
  }
  if (hitsAvailable && attemptsAvailable && hits > attempts) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "checkoutHits must not exceed checkoutAttempts.",
      path: ["checkoutHits"],
    });
  }
  if (attempts === 0 && match.checkoutPercentage !== null && match.checkoutPercentage !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "checkoutPercentage must be unavailable when checkoutAttempts is zero.",
      path: ["checkoutPercentage"],
    });
  }
  if (hitsAvailable && attemptsAvailable && attempts > 0) {
    if (match.checkoutPercentage === null || match.checkoutPercentage === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "checkoutPercentage is required when checkout attempts are available.",
        path: ["checkoutPercentage"],
      });
    } else {
      const expected = Number(((hits / attempts) * 100).toFixed(2));
      if (Math.abs(match.checkoutPercentage - expected) > 0.011) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "checkoutPercentage must match checkoutHits / checkoutAttempts.",
          path: ["checkoutPercentage"],
        });
      }
    }
  }
  if (!hitsAvailable && !attemptsAvailable && match.checkoutPercentage !== null && match.checkoutPercentage !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "checkout counts are required when checkoutPercentage is available.",
      path: ["checkoutPercentage"],
    });
  }
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
