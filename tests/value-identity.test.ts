import { describe, expect, it, vi } from "vitest";
import { DefaultValueReader } from "../src/value/reader.js";
import { DartsOrakelPlayerDirectory } from "../src/value/directory.js";
import type { OddsMatch, OddsMatchIdentityEvidence, OddsReport } from "../src/odds/contracts.js";
import type { Match } from "../src/schemas/match.js";
import type { PlayerIdentity } from "../src/schemas/player.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../src/telegram/stats-service.js";

const ross: PlayerIdentity = { id: 11, name: "Ross Smith", slug: "ross-smith" };
const richard: PlayerIdentity = { id: 12, name: "Richard Smith", slug: "richard-smith" };
const raymond: PlayerIdentity = { id: 14, name: "Raymond Smith", slug: "raymond-smith" };
const cameron: PlayerIdentity = { id: 13, name: "Cameron Menzies", slug: "cameron-menzies" };

function match(eventId: string, player1 = "Smith R.", player2 = "Menzies C."): OddsMatch {
  return {
    eventId,
    competition: "World Grand Prix",
    player1,
    player2,
    odds1: 2.2,
    odds2: 1.7,
    bookmaker: "TippmixPro",
    scheduledTime: "20:00",
    sourceUrl: `https://www.eredmenyek.com/merkozes/darts/a/b/?mid=${eventId}`,
  };
}

function evidence(eventId: string, fullName = "Ross Smith", sourcePlayerId = "ross-source"): OddsMatchIdentityEvidence {
  return {
    eventId,
    date: "2026-09-30",
    home: {
      sourcePlayerId,
      fullName,
      profileUrl: `https://www.eredmenyek.com/jatekos/${fullName.toLocaleLowerCase("en-US").replace(/\s+/gu, "-")}/${sourcePlayerId}/`,
    },
    away: {
      sourcePlayerId: "cameron-source",
      fullName: "Cameron Menzies",
      profileUrl: "https://www.eredmenyek.com/jatekos/cameron-menzies/cameron-source/",
    },
  };
}

function report(matches: readonly OddsMatch[]): OddsReport {
  return {
    source: "eredmenyek",
    sourceUrl: "https://www.eredmenyek.com/darts/oddsok/",
    observedAt: "2026-09-30T12:00:00.000Z",
    date: "2026-09-30",
    timeZone: "Europe/Budapest",
    matches,
    warnings: [],
  };
}

function stats(player: PlayerIdentity): PlayerStatsResult {
  const matches: Match[] = Array.from({ length: 20 }, (_, index): Match => ({
    date: `2026-09-${String(30 - Math.floor(index / 2)).padStart(2, "0")}`,
    tournament: "Test",
    round: "Final",
    result: "Won",
    opponent: "Opponent",
    score: "6-3",
    average: 90 + index,
    oneEighties: index,
    checkoutHits: 2,
    checkoutAttempts: 4,
    checkoutPercentage: 50,
  }));
  return {
    playerName: player.name,
    requestedCount: 20,
    matches,
    meanAverage: 95,
    availableAverageCount: 20,
    sourceUrl: `https://dartsorakel.com/player/details/${player.id}/${player.slug}`,
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
  };
}

function makeReader(
  matches: readonly OddsMatch[],
  lookup: (candidates: readonly OddsMatch[]) => ReadonlyMap<string, OddsMatchIdentityEvidence>,
  directory: readonly PlayerIdentity[],
  provider?: IdentityProvider,
  identityEvidenceLimit?: number,
): DefaultValueReader {
  const statsReader: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => stats(directory.find((player): boolean => player.name === name) ?? ross)) };
  return new DefaultValueReader({
    oddsReader: {
      getOdds: vi.fn(async (): Promise<OddsReport> => report(matches)),
      getIdentityEvidence: vi.fn(provider ?? (async (candidates: readonly OddsMatch[]): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>> => lookup(candidates))),
      ...(identityEvidenceLimit === undefined ? {} : { maxIdentityEvidenceMatches: identityEvidenceLimit }),
    },
    playerStatsReader: statsReader,
    playerDirectory: { getPlayers: vi.fn(async (): Promise<readonly PlayerIdentity[]> => directory) },
  });
}

type IdentityProvider = (candidates: readonly OddsMatch[], date: string, signal?: AbortSignal) => Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>>;

describe("value source identity joins", () => {
  it("keeps identical directory duplicates but quarantines conflicting canonical IDs", async () => {
    const directory = new DartsOrakelPlayerDirectory({
      getPlayerStats: vi.fn(async () => ({
        draw: 0,
        recordsTotal: 3,
        recordsFiltered: 3,
        data: [
          { player_key: 11, player_name: "Ross Smith", player_profile_url: "https://dartsorakel.com/player/details/11/ross-smith" },
          { player_key: 11, player_name: "Ross Smith", player_profile_url: "https://dartsorakel.com/player/details/11/ross-smith" },
          { player_key: 12, player_name: "Raymond Smith", player_profile_url: "https://dartsorakel.com/player/details/12/raymond-smith" },
          { player_key: 12, player_name: "Richard Smith", player_profile_url: "https://dartsorakel.com/player/details/12/richard-smith" },
        ],
      })),
    });
    const players = await directory.getPlayers();
    expect(players).toEqual([ross]);
  });

  it("uses exact full names keyed by source profile ID when abbreviated names are ambiguous", async () => {
    const current = match("ambiguous");
    const reader = makeReader([current], () => new Map([[current.eventId, evidence(current.eventId)]]), [ross, richard, cameron]);
    const result = await reader.getReport("today");
    expect(result.cards[0]?.player1.identity).toEqual(ross);
    expect(result.cards[0]?.player2.identity).toEqual(cameron);
    expect(result.cards[0]?.match.identityEvidence?.home.fullName).toBe("Ross Smith");
  });

  it("quarantines every slot when one source profile ID has conflicting full names", async () => {
    const first = match("first");
    const second = match("second");
    const reader = makeReader(
      [first, second],
      (candidates): ReadonlyMap<string, OddsMatchIdentityEvidence> => new Map([
        [candidates[0]?.eventId ?? "", evidence("first", "Ross Smith", "shared-source")],
        [candidates[1]?.eventId ?? "", evidence("second", "Richard Smith", "shared-source")],
      ]),
      [ross, richard, cameron],
    );
    const result = await reader.getReport("today");
    expect(result.cards.every((card): boolean => card.player1.status === "unresolved")).toBe(true);
    expect(result.cards[0]?.player1.error).toMatch(/conflicting/iu);
    expect(result.cards.every((card): boolean => card.match.identityEvidence === undefined)).toBe(true);
  });

  it("does not keep a unique but wrong abbreviated directory guess", async () => {
    const current = match("wrong-guess");
    const reader = makeReader([current], () => new Map([[current.eventId, evidence(current.eventId, "Ross Smith")]]), [raymond, cameron]);
    const result = await reader.getReport("today");
    expect(result.cards[0]?.player1.identity).toBeNull();
    expect(result.cards[0]?.player1.error).toMatch(/canonical player directory/iu);
  });

  it.each([
    ["missing evidence", async (): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>> => new Map()],
    ["wrong date", async (candidates: readonly OddsMatch[]): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>> => new Map([[candidates[0]?.eventId ?? "", { ...evidence(candidates[0]?.eventId ?? ""), date: "2026-09-29" }]])],
    ["invalid profile URL", async (candidates: readonly OddsMatch[]): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>> => new Map([[candidates[0]?.eventId ?? "", { ...evidence(candidates[0]?.eventId ?? ""), home: { ...evidence(candidates[0]?.eventId ?? "").home, profileUrl: "https://example.test/player/ross" } }]])],
  ])("does not keep an abbreviated guess when provider returns %s", async (_label, provider): Promise<void> => {
    const current = match(`provider-${_label}`);
    const reader = makeReader([current], () => new Map(), [raymond, cameron], provider);
    const result = await reader.getReport("today");
    expect(result.cards[0]?.player1.identity).toBeNull();
    expect(result.cards[0]?.player1.status).toBe("unresolved");
  });

  it("also abstains on leading-initial abbreviations without source evidence", async () => {
    const current = match("leading-initial", "R Smith");
    const reader = makeReader([current], () => new Map(), [ross, cameron]);
    const result = await reader.getReport("today");
    expect(result.cards[0]?.player1.identity).toBeNull();
    expect(result.cards[0]?.player1.status).toBe("unresolved");
  });

  it("does not keep an abbreviated guess after identity provider cancellation", async () => {
    const current = match("provider-cancelled");
    const controller = new AbortController();
    const provider: IdentityProvider = async (_candidates, _date, _signal): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>> => {
      controller.abort(new Error("identity provider cancelled"));
      throw new Error("identity provider cancelled");
    };
    const reader = makeReader([current], () => new Map(), [raymond, cameron], provider);
    const result = await reader.getReport("today", controller.signal);
    expect(result.cards[0]?.player1.identity).toBeNull();
    expect(result.cards[0]?.player1.status).toBe("cancelled");
  });

  it("retains every card and discloses bounded identity coverage", async () => {
    const matches = Array.from({ length: 13 }, (_index: number, index: number): OddsMatch => match(`capacity-${index}`));
    const reader = makeReader(
      matches,
      (candidates): ReadonlyMap<string, OddsMatchIdentityEvidence> => new Map(candidates.map((candidate): readonly [string, OddsMatchIdentityEvidence] => [candidate.eventId, evidence(candidate.eventId)])),
      [ross, cameron],
      undefined,
      12,
    );
    const result = await reader.getReport("today");
    expect(result.cards).toHaveLength(13);
    expect(result.cards.slice(0, 12).every((card): boolean => card.player1.identity?.id === ross.id)).toBe(true);
    expect(result.cards[12]?.player1.identity).toBeNull();
    expect(result.warnings.join("\n")).toContain("Source identity verification was bounded to 12 of 13 odds matchups; 1 remaining abbreviated or unresolved matchup(s) remain unverified.");
  });
});
