import { z } from "zod";

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD).").refine(
  (value: string): boolean => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  },
  "Date is not valid.",
);

export interface ResolvedDate {
  date: string;
  resolvedFrom: "explicit" | "relative" | "weekday";
  timeZone: string;
}

const RELATIVE_TERMS: Readonly<Record<string, number>> = { today: 0, ma: 0, tomorrow: 1, holnap: 1 };
const WEEKDAY_TERMS: Readonly<Record<string, number>> = {
  sunday: 0, vasarnap: 0, monday: 1, hetfo: 1, tuesday: 2, kedd: 2,
  wednesday: 3, szerda: 3, thursday: 4, csutortok: 4, friday: 5,
  pentek: 5, saturday: 6, szombat: 6,
};

export function resolveResearchDate(
  expression: string,
  options: { now?: Date; timeZone?: string } = {},
): ResolvedDate {
  const trimmed = expression.trim();
  if (trimmed === "") throw new Error("Date expression must not be empty.");
  const timeZone = options.timeZone ?? "Europe/Budapest";
  const now = options.now ?? new Date();
  const explicit = /\b\d{4}-\d{2}-\d{2}\b/.exec(trimmed)?.[0];
  if (explicit !== undefined) return { date: IsoDateSchema.parse(explicit), resolvedFrom: "explicit", timeZone };

  const normalized = normalizeExpression(trimmed);
  const localDate = localIsoDate(now, timeZone);
  for (const [term, offset] of Object.entries(RELATIVE_TERMS)) {
    if (containsWord(normalized, term)) return { date: addDays(localDate, offset), resolvedFrom: "relative", timeZone };
  }
  for (const [term, targetDay] of Object.entries(WEEKDAY_TERMS)) {
    if (containsWord(normalized, term) || normalized.includes(`${term}i`)) {
      const currentDay = new Date(`${localDate}T00:00:00Z`).getUTCDay();
      return { date: addDays(localDate, (targetDay - currentDay + 7) % 7), resolvedFrom: "weekday", timeZone };
    }
  }
  throw new Error(`Unable to resolve date expression ${JSON.stringify(expression)}. Use an ISO date, today/tomorrow, ma/holnap, or a weekday.`);
}

function normalizeExpression(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US");
}
function containsWord(value: string, term: string): boolean {
  return new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, "i").test(value);
}
function localIsoDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return IsoDateSchema.parse(`${value("year")}-${value("month")}-${value("day")}`);
}
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

