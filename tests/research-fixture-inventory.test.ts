import { describe, expect, it, vi } from "vitest";

import { PlayerAmbiguousError, PlayerNotFoundError } from "../src/errors.js";
import { ReportDeadlineExceededError } from "../src/daily/report-budget.js";
import { ModusFixtureSchema, type ModusFixture } from "../src/modus/schemas.js";
import { PdcTournamentService } from "../src/pdc/service.js";
import { PdcFixtureSchema, type PdcFixture, type PdcTournamentSource } from "../src/pdc/schemas.js";
import {
  MAX_FIXTURE_INVENTORY_FIXTURES,
  MAX_FIXTURE_INVENTORY_PARTICIPANTS,
  buildFixtureInventory,
  finalizeFixtureInventoryUnresolved,
  resolveFixtureInventory,
} from "../src/research/fixture-inventory.js";
import type { PlayerIdentity } from "../src/schemas/player.js";

const DATE = "2026-10-06";

function pdcFixture(overrides: Partial<PdcFixture> = {}): PdcFixture {
  return PdcFixtureSchema.parse({
    id: "event:fixture-1",
    tournamentName: "World Series Finals 2026",
    date: DATE,
    startTime: null,
    session: null,
    round: "Round One",
    playerOne: "Luke Cross",
    playerTwo: "Rob Smith",
    sourceUrl: "https://pdpa.co.uk/event/world-series/",
    ...overrides,
  });
}

function modusFixture(overrides: Partial<ModusFixture> = {}): ModusFixture {
  return ModusFixtureSchema.parse({
    id: "modus:fixture-1",
    event: "MODUS Super Series",
    date: DATE,
    startTime: null,
    playerOne: "Luke Cross",
    playerTwo: "Rob Smith",
    source: "https://modussuperseries.com/fixtures/",
    ...overrides,
  });
}

function identity(id: number, name: string): PlayerIdentity {
  return { id, name, slug: name.toLocaleLowerCase("en-US").replaceAll(" ", "-") };
}

describe("fixture-derived participant inventory", () => {
  it("quarantines a fixture whose different labels resolve to the same player", async () => {
    const draft = buildFixtureInventory("pdc", DATE, [pdcFixture({ playerOne: "Luke Cross", playerTwo: "Cross L." })]);
    const inventory = await resolveFixtureInventory(draft, async (): Promise<PlayerIdentity> => identity(1, "Luke Cross"));
    expect(inventory.participants).toHaveLength(0);
    expect(inventory.references.map((reference) => reference.reason)).toEqual(["identity-conflict", "identity-conflict"]);
    expect(inventory.references).toHaveLength(2);
  });
  it("preserves repeat participants, aliases, source occurrences, and rematches", async () => {
    const fixtures = [
      pdcFixture({ playerOne: "Luke Cross" }),
      pdcFixture({ id: "event:rematch", playerOne: "Cross, Luke", startTime: "2026-10-06T18:00:00Z" }),
    ];
    const draft = buildFixtureInventory("pdc", DATE, fixtures);
    const resolver = vi.fn(async (name: string): Promise<PlayerIdentity> => {
      if (name === "Luke Cross" || name === "Cross, Luke") return identity(10, "Luke Cross");
      if (name === "Rob Smith") return identity(20, "Rob Smith");
      throw new PlayerNotFoundError(name);
    });

    const inventory = await resolveFixtureInventory(draft, resolver);

    expect(inventory.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(inventory.source).toBe("pdc");
    expect(inventory.fixtures).toHaveLength(2);
    expect(inventory.fixtures[0]?.occurrenceId).not.toBe(inventory.fixtures[1]?.occurrenceId);
    expect(inventory.references).toHaveLength(4);
    expect(inventory.participants.map((participant) => participant.player.id)).toEqual([10, 20]);
    expect(inventory.participants[0]).toMatchObject({
      player: { id: 10, name: "Luke Cross" },
      aliases: ["Luke Cross", "Cross, Luke"],
      referenceIds: [inventory.references[0]?.id, inventory.references[2]?.id],
      fixtureOccurrences: [inventory.fixtures[0]?.occurrenceId, inventory.fixtures[1]?.occurrenceId],
      inventoryIndex: 0,
      startTime: "2026-10-06T18:00:00Z",
    });
    expect(inventory.references.map((reference) => reference.status)).toEqual(["resolved", "resolved", "resolved", "resolved"]);
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it("produces deterministic source/date/occurrence identity and changes when a replacement changes", () => {
    const original = [pdcFixture()];
    const first = buildFixtureInventory("pdc", DATE, original);
    const repeated = buildFixtureInventory("pdc", DATE, original);
    const replacement = buildFixtureInventory("pdc", DATE, [pdcFixture({ playerTwo: "Daryl Gurney" })]);
    const otherSource = buildFixtureInventory("modus", DATE, [modusFixture()]);

    expect(first.id).toBe(repeated.id);
    expect(first.references.map((reference) => reference.id)).toEqual(repeated.references.map((reference) => reference.id));
    expect(replacement.id).not.toBe(first.id);
    expect(otherSource.id).not.toBe(first.id);
  });

  it("retains unknown MODUS start times and excludes placeholders without resolving them", async () => {
    const draft = buildFixtureInventory("modus", DATE, [modusFixture({ playerOne: "TBD", playerTwo: "Rob Smith" })]);
    const resolver = vi.fn(async (): Promise<PlayerIdentity> => identity(20, "Rob Smith"));
    const inventory = await resolveFixtureInventory(draft, resolver);

    expect(inventory.fixtures[0]?.startTime).toBeNull();
    expect(inventory.references[0]).toMatchObject({ requestedName: "TBD", status: "unresolved", reason: "placeholder" });
    expect(inventory.references[1]).toMatchObject({ requestedName: "Rob Smith", status: "resolved", participantId: 20 });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("keeps date-mismatched fixtures and their original names explicit without resolving them", async () => {
    const draft = buildFixtureInventory("pdc", DATE, [pdcFixture({ date: "2026-10-07" })]);
    const resolver = vi.fn(async (): Promise<PlayerIdentity> => identity(1, "Unexpected"));
    const inventory = await resolveFixtureInventory(draft, resolver);

    expect(inventory.fixtures).toHaveLength(1);
    expect(inventory.fixtures[0]?.date).toBe("2026-10-07");
    expect(inventory.references.map((reference) => [reference.requestedName, reference.reason])).toEqual([
      ["Luke Cross", "fixture-date-mismatch"],
      ["Rob Smith", "fixture-date-mismatch"],
    ]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("records ambiguous and unknown identities as unresolved stable reasons", async () => {
    const draft = buildFixtureInventory("pdc", DATE, [pdcFixture({ playerOne: "Ambiguous Alias", playerTwo: "Missing Alias" })]);
    const inventory = await resolveFixtureInventory(draft, async (name: string): Promise<PlayerIdentity> => {
      if (name === "Ambiguous Alias") throw new PlayerAmbiguousError(name, ["Alex One", "Alex Two"]);
      throw new PlayerNotFoundError(name);
    });

    expect(inventory.participants).toEqual([]);
    expect(inventory.references.map((reference) => [reference.status, reference.reason])).toEqual([
      ["unresolved", "ambiguous"],
      ["unresolved", "unresolved"],
    ]);
  });

  it("quarantines inconsistent identities returned for the same canonical ID", async () => {
    const draft = buildFixtureInventory("pdc", DATE, [pdcFixture({ playerOne: "Alias One", playerTwo: "Alias Two" })]);
    const inventory = await resolveFixtureInventory(draft, async (name: string): Promise<PlayerIdentity> => (
      identity(77, name === "Alias One" ? "Canonical One" : "Canonical Two")
    ));

    expect(inventory.participants).toEqual([]);
    expect(inventory.references.map((reference) => reference.reason)).toEqual(["identity-conflict", "identity-conflict"]);
  });

  it("caps canonical participants at 100 but retains every overflow reference", async () => {
    const fixtures = Array.from({ length: 51 }, (_, index: number): PdcFixture => pdcFixture({
      id: `fixture-${index}`,
      playerOne: `Competitor ${index * 2 + 1}`,
      playerTwo: `Competitor ${index * 2 + 2}`,
    }));
    const draft = buildFixtureInventory("pdc", DATE, fixtures);
    const inventory = await resolveFixtureInventory(draft, async (name: string): Promise<PlayerIdentity> => {
      const id = Number(name.slice("Competitor ".length));
      return identity(id, name);
    });

    expect(inventory.participants).toHaveLength(MAX_FIXTURE_INVENTORY_PARTICIPANTS);
    expect(inventory.references).toHaveLength(102);
    expect(inventory.references.filter((reference) => reference.status === "excluded-limit")).toHaveLength(2);
    expect(inventory.references.slice(-2).map((reference) => reference.reason)).toEqual(["excluded-limit", "excluded-limit"]);
  });

  it("makes pending raw references explicit when a collector finalizes at its deadline", () => {
    const inventory = finalizeFixtureInventoryUnresolved(buildFixtureInventory("pdc", DATE, [pdcFixture()]));

    expect(inventory.participants).toEqual([]);
    expect(inventory.references.every((reference) => reference.status === "unresolved" && reference.reason === "unresolved")).toBe(true);
    expect(inventory.references.map((reference) => reference.requestedName)).toEqual(["Luke Cross", "Rob Smith"]);
  });

  it("propagates the caller's cancellation reason rather than converting it to an unresolved result", async () => {
    const controller = new AbortController();
    const ownerReason = new Error("owner stopped the run");
    const inventory = buildFixtureInventory("pdc", DATE, [pdcFixture()]);
    const resolver = vi.fn(async (): Promise<PlayerIdentity> => {
      controller.abort(ownerReason);
      return identity(10, "Luke Cross");
    });

    await expect(resolveFixtureInventory(inventory, resolver, controller.signal)).rejects.toBe(ownerReason);
  });

  it("returns explicit deadline references and preserves non-cooperative resolver failures", async () => {
    const draft = buildFixtureInventory("pdc", DATE, [pdcFixture()]);
    const controller = new AbortController();
    const deadline = new ReportDeadlineExceededError("research");
    const resolution = resolveFixtureInventory(draft, async (): Promise<PlayerIdentity> => new Promise<PlayerIdentity>(() => undefined), controller.signal);
    controller.abort(deadline);
    const partial = await resolution;
    const unavailable = await resolveFixtureInventory(draft, async (): Promise<PlayerIdentity> => { throw new Error("source offline"); });

    expect(partial.references.map((reference) => reference.reason)).toEqual(["deadline", "deadline"]);
    expect(unavailable.references.map((reference) => reference.reason)).toEqual(["source-unavailable", "source-unavailable"]);
  });

  it("rejects invalid dates, malformed or unsafe URLs, and more than 1000 fixtures", () => {
    expect(() => buildFixtureInventory("pdc", "2026-02-30", [])).toThrow();
    expect(() => buildFixtureInventory("pdc", DATE, [pdcFixture({ sourceUrl: "javascript:alert(1)" })])).toThrow(/safe HTTPS/u);
    expect(() => buildFixtureInventory("pdc", DATE, [pdcFixture({ sourceUrl: "http://pdpa.co.uk/event/world-series/" })])).toThrow(/safe HTTPS/u);
    expect(() => buildFixtureInventory("pdc", DATE, [pdcFixture({ sourceUrl: "https://user:password@pdpa.co.uk/event/" })])).toThrow(/safe HTTPS/u);
    expect(() => buildFixtureInventory("pdc", DATE, [pdcFixture({ playerOne: "A".repeat(121) })])).toThrow(/120 characters/u);
    const overflow = Array.from({ length: MAX_FIXTURE_INVENTORY_FIXTURES + 1 }, (_, index: number): PdcFixture => pdcFixture({ id: `fixture-${index}` }));
    expect(() => buildFixtureInventory("pdc", DATE, overflow)).toThrow(/At most 1000 fixtures/u);
    expect(() => buildFixtureInventory("pdc", DATE, [{ ...pdcFixture(), playerTwo: "   " }])).toThrow();
  });

  it("exposes PDC fixtures-only discovery without requiring player statistics", async () => {
    const getFixtures = vi.fn(async (date: string): Promise<readonly PdcFixture[]> => [pdcFixture({ date })]);
    const source: PdcTournamentSource = {
      getCalendar: async () => [],
      getResults: async () => { throw new Error("not used"); },
    };
    const service = new PdcTournamentService({ source, fixtureSource: { name: "fixtures", getFixtures } });

    await expect(service.getFixturesForDate(DATE)).resolves.toEqual([pdcFixture()]);
    expect(getFixtures).toHaveBeenCalledWith(DATE);
    await expect(service.getFixturesForDate("bad-date")).rejects.toThrow();
    await expect(new PdcTournamentService({ source }).getFixturesForDate(DATE)).rejects.toThrow("PDC fixture source is not configured.");
  });
});
