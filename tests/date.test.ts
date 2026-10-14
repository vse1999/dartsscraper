import { describe, expect, it } from "vitest";
import { dateInTimeZone, resolveResearchDate, resolveTomorrowDate } from "../src/agent/date.js";

describe("research date resolution", () => {
  const now = new Date("2026-08-08T12:00:00Z");
  it("accepts an explicit date", () => expect(resolveResearchDate("2026-08-17", { now }).date).toBe("2026-08-17"));
  it("resolves English and Hungarian today", () => {
    expect(resolveResearchDate("today", { now }).date).toBe("2026-08-08");
    expect(resolveResearchDate("ma", { now }).date).toBe("2026-08-08");
  });
  it("resolves English and Hungarian tomorrow", () => {
    expect(resolveResearchDate("tomorrow", { now }).date).toBe("2026-08-09");
    expect(resolveResearchDate("holnap", { now }).date).toBe("2026-08-09");
  });
  it("resolves tomorrow from the Budapest calendar date at a UTC boundary", () => {
    expect(resolveTomorrowDate({ now: new Date("2026-09-10T22:30:00Z"), timeZone: "Europe/Budapest" })).toBe("2026-09-12");
  });
  it("resolves Monday and hétfői to the next occurrence", () => {
    expect(resolveResearchDate("Monday", { now }).date).toBe("2026-08-10");
    expect(resolveResearchDate("hétfői MODUS játékosok", { now }).date).toBe("2026-08-10");
  });
  it("rejects impossible ISO dates", () => expect(() => resolveResearchDate("2026-02-31", { now })).toThrow());
  it("rejects unresolved prose rather than guessing", () => expect(() => resolveResearchDate("valamikor", { now })).toThrow("Unable to resolve"));
  it("converts offset-bearing live timestamps to Budapest dates across midnight and the DST fallback", () => {
    expect(dateInTimeZone("2026-10-10T22:30:00Z")).toBe("2026-10-11");
    expect(dateInTimeZone("2026-10-25T00:30:00Z")).toBe("2026-10-25");
    expect(dateInTimeZone("2026-10-25T01:30:00Z")).toBe("2026-10-25");
  });
  it("requires an explicit timezone instead of interpreting a bare local time as UTC", () => {
    expect(() => dateInTimeZone("2026-10-11T23:30:00")).toThrow("explicit timezone offset");
  });
});

