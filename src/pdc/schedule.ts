import { PdcFixtureSchema, PdcScheduleEventSchema, PdcScheduleSnapshotSchema, type PdcFixture, type PdcScheduleEvent, type PdcScheduleSnapshot } from "./schemas.js";

export function flattenScheduleFixtures(snapshot: PdcScheduleSnapshot): readonly PdcFixture[] {
  return snapshot.events.flatMap((event) => event.fixtures);
}

export function samePdcFixture(left: PdcFixture, right: PdcFixture): boolean {
  const evidenceUrlsMatch = left.evidenceUrls === undefined || right.evidenceUrls === undefined
    ? left.evidenceUrls === right.evidenceUrls
    : left.evidenceUrls.length === right.evidenceUrls.length
      && left.evidenceUrls.every((url, index) => url === right.evidenceUrls?.[index]);
  return left.id === right.id
    && left.tournamentName === right.tournamentName
    && left.date === right.date
    && left.startTime === right.startTime
    && left.session === right.session
    && left.round === right.round
    && left.playerOne === right.playerOne
    && left.playerTwo === right.playerTwo
    && left.sourceUrl === right.sourceUrl
    && evidenceUrlsMatch;
}

export function createCalendarUnavailableSnapshot(date: string, observedAt: string): PdcScheduleSnapshot {
  return PdcScheduleSnapshotSchema.parse({
    schemaVersion: 1,
    date,
    timeZone: "Europe/Budapest",
    observedAt,
    calendarStatus: "unavailable",
    calendarReason: "calendar_unavailable",
    events: [],
  });
}

/** Preserve source-backed rows when a legacy adapter cannot validate whole-calendar scope. */
export function createFallbackScheduleSnapshot(date: string, observedAt: string, fixtures: readonly PdcFixture[]): PdcScheduleSnapshot {
  const validated = PdcFixtureSchema.array().parse(fixtures);
  if (validated.some((fixture) => fixture.date !== date)) throw new Error("A PDC source returned a fixture for a different date.");
  const grouped = new Map<string, PdcFixture[]>();
  for (const fixture of validated) {
    const identity = eventNameIdentity(fixture.tournamentName);
    const rows = grouped.get(identity) ?? [];
    rows.push(fixture);
    grouped.set(identity, rows);
  }
  const events = [...grouped].map(([identity, rows]): PdcScheduleEvent => ({
    eventId: `fallback:${identity}`.slice(0, 160),
    name: rows[0]?.tournamentName ?? "PDC schedule",
    coverage: "partial",
    fixtures: rows,
    pendingSlots: null,
    reason: "fallback_only",
    evidenceUrls: [...new Set(rows.flatMap((fixture) => [fixture.sourceUrl, ...(fixture.evidenceUrls ?? [])]))].slice(0, 10),
  }));
  return PdcScheduleSnapshotSchema.parse({
    schemaVersion: 1,
    date,
    timeZone: "Europe/Budapest",
    observedAt,
    calendarStatus: "unavailable",
    calendarReason: "calendar_unavailable",
    events,
  });
}

/** Merge only fixtures whose event identity has one exact normalized match. */
export function mergeFallbackFixtures(
  snapshot: PdcScheduleSnapshot,
  input: readonly PdcFixture[],
): PdcScheduleSnapshot {
  const fixtures = PdcFixtureSchema.array().parse(input);
  if (fixtures.some((fixture) => fixture.date !== snapshot.date)) {
    throw new Error("A PDC fallback returned a fixture for a different date.");
  }
  if (fixtures.length === 0) return snapshot;
  if (snapshot.calendarStatus === "unavailable") return addUnmappedFallbackEvents(snapshot, fixtures);

  const grouped = new Map<string, PdcFixture[]>();
  for (const fixture of fixtures) {
    const identity = eventNameIdentity(fixture.tournamentName);
    const matches = snapshot.events.filter((event) => eventNameIdentity(event.name) === identity);
    if (matches.length !== 1) continue;
    const event = matches[0];
    if (event === undefined || event.coverage === "available") continue;
    const rows = grouped.get(event.eventId) ?? [];
    rows.push(fixture);
    grouped.set(event.eventId, rows);
  }

  const events = snapshot.events.map((event): PdcScheduleEvent => {
    const additions = grouped.get(event.eventId);
    if (additions === undefined || additions.length === 0) return event;
    const rows = [...event.fixtures];
    for (const addition of additions) {
      const duplicateIndex = rows.findIndex((existing) => (
        existing.id === addition.id
        || sameDatedRoundPairing(existing, addition)
      ));
      if (duplicateIndex < 0) {
        rows.push(PdcFixtureSchema.parse({ ...addition, tournamentName: event.name }));
        continue;
      }
      const existing = rows[duplicateIndex];
      if (existing === undefined) continue;
      rows[duplicateIndex] = PdcFixtureSchema.parse({
        ...existing,
        evidenceUrls: [...new Set([...(existing.evidenceUrls ?? [existing.sourceUrl]), addition.sourceUrl, ...(addition.evidenceUrls ?? [])])],
      });
    }
    const evidenceUrls = [...new Set([...event.evidenceUrls, ...additions.flatMap((fixture) => [fixture.sourceUrl, ...(fixture.evidenceUrls ?? [])])])].slice(0, 10);
    const coverage = "partial";
    const reason = event.reason === "opponents_unassigned" ? event.reason : "fallback_only";
    return PdcScheduleEventSchema.parse({
      ...event,
      coverage,
      fixtures: rows,
      reason,
      evidenceUrls,
    });
  });

  return PdcScheduleSnapshotSchema.parse({ ...snapshot, events });
}

function addUnmappedFallbackEvents(snapshot: PdcScheduleSnapshot, fixtures: readonly PdcFixture[]): PdcScheduleSnapshot {
  const byIdentity = new Map<string, PdcFixture[]>();
  for (const fixture of fixtures) {
    const identity = eventNameIdentity(fixture.tournamentName);
    if (identity === "") continue;
    const rows = byIdentity.get(identity) ?? [];
    rows.push(fixture);
    byIdentity.set(identity, rows);
  }
  const events = [...snapshot.events];
  for (const [identity, rows] of byIdentity) {
    const name = rows[0]?.tournamentName;
    if (name === undefined || name === "") continue;
    events.push({
      eventId: `fallback:${identity}`.slice(0, 160),
      name,
      coverage: "partial",
      fixtures: rows,
      pendingSlots: null,
      reason: "fallback_only",
      evidenceUrls: [...new Set(rows.flatMap((fixture) => [fixture.sourceUrl, ...(fixture.evidenceUrls ?? [])]))].slice(0, 10),
    });
  }
  return PdcScheduleSnapshotSchema.parse({ ...snapshot, events });
}

function sameDatedRoundPairing(left: PdcFixture, right: PdcFixture): boolean {
  if (left.date !== right.date || left.round === null || right.round === null) return false;
  if (normalizeText(left.round).toLocaleLowerCase("en-US") !== normalizeText(right.round).toLocaleLowerCase("en-US")) return false;
  const leftPlayers = [playerIdentity(left.playerOne), playerIdentity(left.playerTwo)].sort();
  const rightPlayers = [playerIdentity(right.playerOne), playerIdentity(right.playerTwo)].sort();
  return leftPlayers[0] !== "" && leftPlayers[0] === rightPlayers[0] && leftPlayers[1] === rightPlayers[1]
    && eventNameIdentity(left.tournamentName) === eventNameIdentity(right.tournamentName);
}

function eventNameIdentity(value: string): string {
  return normalizeText(value)
    .toLocaleLowerCase("en-US")
    .replace(/\b20\d{2}\b/gu, " ")
    .replace(/^pdc\s+/u, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function playerIdentity(value: string): string {
  return normalizeText(value).toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
