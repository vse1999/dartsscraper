import { describe, expect, it, vi } from "vitest";

import { PlayerNotFoundError } from "../src/errors.js";
import { PlayerResolver, normalizePlayerName, playerIdentityFromStatsRow } from "../src/player/resolver.js";
import type { PlayerStatsResponse } from "../src/schemas/player.js";
import { readPlayerStatsFixture } from "./helpers.js";

function resolverFor(response: PlayerStatsResponse): PlayerResolver {
  return new PlayerResolver({ getPlayerStats: async () => response });
}

describe("player resolver", () => {
  it("resolves Damon Heta from the live-shaped stats fixture", async () => {
    await expect(resolverFor(readPlayerStatsFixture()).resolvePlayer(" Damon   HETA ")).resolves.toEqual({
      id: 13,
      name: "Damon Heta",
      slug: "damon-heta",
    });
  });

  it("resolves Robert Thornton without a hardcoded ID", async () => {
    await expect(resolverFor(readPlayerStatsFixture()).resolvePlayer("robert thornton")).resolves.toEqual({
      id: 73,
      name: "Robert Thornton",
      slug: "robert-thornton",
    });
  });

  it("normalizes Unicode and whitespace deterministically", () => {
    expect(normalizePlayerName("  Karel\u00a0Sedláček ")).toBe("karel sedláček");
  });

  it("rejects an unknown player", async () => {
    await expect(resolverFor(readPlayerStatsFixture()).resolvePlayer("Unknown Player")).rejects.toThrow(PlayerNotFoundError);
  });

  it("rejects multiple normalized exact matches", async () => {
    const response = readPlayerStatsFixture();
    const first = response.data[0];
    if (first === undefined) {
      throw new Error("Fixture must contain a player.");
    }
    const duplicate = { ...first, player_key: 99999, player_profile_url: "https://dartsorakel.com/player/details/99999/duplicate" };
    const ambiguous: PlayerStatsResponse = { ...response, data: [first, duplicate] };

    await expect(resolverFor(ambiguous).resolvePlayer(first.player_name)).rejects.toThrow("ambiguous");
  });

  it("derives ID and slug from the profile URL", () => {
    expect(playerIdentityFromStatsRow({
      player_key: 73,
      player_name: "Robert Thornton",
      player_profile_url: "https://dartsorakel.com/player/details/73/robert-thornton",
    })).toEqual({ id: 73, name: "Robert Thornton", slug: "robert-thornton" });
  });

  it("loads the player directory once and finds names inside natural-language questions", async () => {
    const getPlayerStats = vi.fn().mockResolvedValue(readPlayerStatsFixture());
    const resolver = new PlayerResolver({ getPlayerStats });

    await resolver.preload();
    await expect(resolver.findMentions("Show Damon Heta's last 10 matches")).resolves.toContainEqual({
      id: 13,
      name: "Damon Heta",
      slug: "damon-heta",
    });
    await resolver.resolvePlayer("Damon Heta");

    expect(getPlayerStats).toHaveBeenCalledTimes(1);
  });
});
