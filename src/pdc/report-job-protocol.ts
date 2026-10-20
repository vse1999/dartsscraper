import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IsoDateSchema } from "../agent/date.js";
import { PdcFixtureSchema, PdcScheduleSnapshotSchema } from "./schemas.js";
import { samePdcFixture } from "./schedule.js";

export const PDC_JOB_BATCH_SIZE = 4;
export const PDC_JOB_MAX_BYTES = 256 * 1024;
export const PDC_JOB_TTL_MS = 60 * 60_000;
const JobFixtureSchema = PdcFixtureSchema.and(z.object({
  id: z.string().max(160), tournamentName: z.string().max(160), playerOne: z.string().max(80), playerTwo: z.string().max(80),
  sourceUrl: z.string().max(500), evidenceUrls: z.array(z.string().max(500)).max(10).optional(),
}));
export const PdcReportJobSchema = z.object({
  version: z.literal(1), jobId: z.string().uuid(), date: IsoDateSchema,
  createdAt: z.string().datetime(), acknowledgementMessageId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cursor: z.number().int().nonnegative(),
  deliveredCount: z.number().int().nonnegative().max(128).optional(),
  failedCount: z.number().int().nonnegative().max(128).optional(),
  deliveredFixtureIds: z.array(z.string().trim().min(1).max(160)).max(128).optional(),
  fixtures: z.array(JobFixtureSchema).max(128).optional(),
  schedule: PdcScheduleSnapshotSchema.optional(),
}).strict().superRefine((job, context): void => {
  const emptyInitialSchedule = job.fixtures?.length === 0 && job.schedule !== undefined && job.cursor === 0;
  if (job.cursor % PDC_JOB_BATCH_SIZE !== 0 || (job.fixtures === undefined ? job.cursor !== 0 : job.fixtures.length === 0 ? !emptyInitialSchedule : job.cursor >= job.fixtures.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid PDC job cursor." });
  }
  if (job.fixtures?.some((fixture) => fixture.date !== job.date) === true) context.addIssue({ code: z.ZodIssueCode.custom, message: "PDC job dates disagree." });
  if (job.fixtures !== undefined && new Set(job.fixtures.map((fixture) => fixture.id)).size !== job.fixtures.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "PDC job repeated a fixture ID." });
  if (job.schedule !== undefined) {
    const scheduledFixtures = job.schedule.events.flatMap((event) => event.fixtures);
    if (job.schedule.date !== job.date || job.fixtures === undefined || scheduledFixtures.length !== job.fixtures.length
      || scheduledFixtures.some((fixture, index) => {
        const pinnedFixture = job.fixtures?.[index];
        return pinnedFixture === undefined || !samePdcFixture(fixture, pinnedFixture);
      })) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "PDC job schedule and pinned fixtures disagree." });
    }
  }
  if (job.deliveredFixtureIds !== undefined) {
    const deliveredIds = new Set(job.deliveredFixtureIds);
    if (deliveredIds.size !== job.deliveredFixtureIds.length || job.fixtures === undefined
      || job.deliveredFixtureIds.some((id) => !job.fixtures?.some((fixture) => fixture.id === id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "PDC job delivery progress references unknown or repeated fixtures." });
    }
  }
  if (job.deliveredCount !== undefined && job.failedCount !== undefined && job.cursor > 0
    && job.deliveredCount + job.failedCount !== job.cursor) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "PDC job progress counts must equal its processed cursor." });
  }
});
export type PdcReportJob = z.infer<typeof PdcReportJobSchema>;
const SignedJobSchema = z.object({ job: PdcReportJobSchema, signature: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type SignedPdcReportJob = z.infer<typeof SignedJobSchema>;

export function readPdcSigningSecret(environment: { readonly WEBHOOK_SECRET?: string }): string {
  const secret = environment.WEBHOOK_SECRET?.trim();
  if (secret === undefined || !/^[A-Za-z0-9_-]{32,256}$/u.test(secret)) throw new Error("PDC jobs require the existing valid WEBHOOK_SECRET.");
  return secret;
}
export function signPdcJob(input: PdcReportJob, secret: string): SignedPdcReportJob {
  const job = PdcReportJobSchema.parse(input);
  return { job, signature: createHmac("sha256", secret).update(JSON.stringify(job)).digest("hex") };
}
export function verifyPdcJob(input: unknown, secret: string, now: number = Date.now()): SignedPdcReportJob {
  const signed = SignedJobSchema.parse(input);
  const expected = signPdcJob(signed.job, secret).signature;
  if (!timingSafeEqual(Buffer.from(signed.signature, "hex"), Buffer.from(expected, "hex"))) throw new Error("Invalid PDC job signature.");
  const age = now - Date.parse(signed.job.createdAt);
  if (!Number.isFinite(age) || age < -5_000 || age > PDC_JOB_TTL_MS) throw new Error("PDC job is expired or from the future.");
  return signed;
}
