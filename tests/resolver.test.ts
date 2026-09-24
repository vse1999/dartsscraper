import { describe, expect, it, vi } from "vitest";

import { PlayerAmbiguousError, PlayerNotFoundError } from "../src/errors.js";
import { FixtureNameResolver } from "../src/modus/fixture-name-resolver.js";
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

  it("normalizes official MODUS apostrophes and junior suffixes", async () => {
    const response = readPlayerStatsFixture();
    const base = response.data[0];
    if (base === undefined) throw new Error("Fixture must contain a player.");
    const directory: PlayerStatsResponse = {
      ...response,
      data: [
        { ...base, player_key: 1001, player_name: "John O Shea", player_profile_url: "https://dartsorakel.com/player/details/1001/john-o-shea" },
        { ...base, player_key: 1002, player_name: "Ram Guevara jnr", player_profile_url: "https://dartsorakel.com/player/details/1002/ram-guevara-jnr" },
      ],
    };
    const resolver = resolverFor(directory);

    await expect(resolver.resolvePlayer("John O´Shea")).resolves.toMatchObject({ name: "John O Shea" });
    await expect(resolver.resolvePlayer("Ram Guevara Jr")).resolves.toMatchObject({ name: "Ram Guevara jnr" });
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

  it("keeps a shared directory load valid when one consumer is cancelled", async () => {
    let release: () => void = () => undefined;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    const getPlayerStats = vi.fn(async (): Promise<PlayerStatsResponse> => {
      await loading;
      return readPlayerStatsFixture();
    });
    const resolver = new PlayerResolver({ getPlayerStats });
    const shared = resolver.resolvePlayer("Damon Heta");
    const controller = new AbortController();
    const cancelled = resolver.resolvePlayer("Robert Thornton", controller.signal);
    controller.abort(new Error("directory deadline"));
    await expect(cancelled).rejects.toThrow("directory deadline");
    release();
    await expect(shared).resolves.toMatchObject({ name: "Damon Heta" });
    await expect(resolver.resolvePlayer("Robert Thornton")).resolves.toMatchObject({ name: "Robert Thornton" });
    expect(getPlayerStats).toHaveBeenCalledTimes(1);
  });

  it("does not cache a directory load that is cancelled by its only consumer", async () => {
    const getPlayerStats = vi.fn(async (signal?: AbortSignal): Promise<PlayerStatsResponse> => {
      if (signal !== undefined) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw signal.reason instanceof Error ? signal.reason : new Error("cancelled");
      }
      return readPlayerStatsFixture();
    });
    const resolver = new PlayerResolver({ getPlayerStats });
    const controller = new AbortController();
    const cancelled = resolver.resolvePlayer("Damon Heta", controller.signal);
    controller.abort(new Error("directory deadline"));

    await expect(cancelled).rejects.toThrow("directory deadline");
    await expect(resolver.resolvePlayer("Damon Heta")).resolves.toMatchObject({ name: "Damon Heta" });
    expect(getPlayerStats).toHaveBeenCalledTimes(2);
  });

  it("does not share a signal-bound fixture directory load across callers", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const getPlayerStats = vi.fn(async (signal?: AbortSignal): Promise<PlayerStatsResponse> => {
      if (signal === first.signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return readPlayerStatsFixture();
    });
    const resolver = new FixtureNameResolver({ getPlayerStats });

    const cancelled = resolver.resolve("Damon Heta", first.signal);
    await vi.waitFor(() => expect(getPlayerStats).toHaveBeenCalledTimes(1));
    const surviving = resolver.resolve("Robert Thornton", second.signal);
    await vi.waitFor(() => expect(getPlayerStats).toHaveBeenCalledTimes(2));

    first.abort(new Error("fixture directory deadline"));
    await expect(cancelled).rejects.toThrow("fixture directory deadline");
    await expect(surviving).resolves.toBe("Robert Thornton");
    expect(getPlayerStats).toHaveBeenCalledTimes(2);
  });

  it("single-flights signal-bound fixture directory loads for one report", async () => {
    let release: () => void = () => undefined;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    const getPlayerStats = vi.fn(async (_signal?: AbortSignal): Promise<PlayerStatsResponse> => {
      await loading;
      return readPlayerStatsFixture();
    });
    const resolver = new FixtureNameResolver({ getPlayerStats });
    const controller = new AbortController();
    const first = resolver.resolve("Damon Heta", controller.signal);
    const second = resolver.resolve("Robert Thornton", controller.signal);

    await vi.waitFor(() => expect(getPlayerStats).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["Damon Heta", "Robert Thornton"]);
    expect(getPlayerStats).toHaveBeenCalledTimes(1);
  });

  it("resolves a unique partial name and a high-confidence typo", async () => {
    const base = readPlayerStatsFixture().data[0];
    if (base === undefined) throw new Error("Fixture must contain a player.");
    const response: PlayerStatsResponse = {
      draw: 0,
      recordsTotal: 3,
      recordsFiltered: 3,
      data: [
        { ...base, player_key: 1001, player_name: "Gian van Veen", player_profile_url: "https://dartsorakel.com/player/details/1001/gian-van-veen" },
        { ...base, player_key: 1002, player_name: "Danny Noppert", player_profile_url: "https://dartsorakel.com/player/details/1002/danny-noppert" },
        { ...base, player_key: 1003, player_name: "Rob Cross", player_profile_url: "https://dartsorakel.com/player/details/1003/rob-cross" },
      ],
    };
    const resolver = resolverFor(response);

    await expect(resolver.resolvePlayer("van veen")).resolves.toMatchObject({ name: "Gian van Veen" });
    await expect(resolver.resolvePlayer("danny nopper")).resolves.toMatchObject({ name: "Danny Noppert" });
  });

  it("rejects ambiguous partial names instead of guessing", async () => {
    const base = readPlayerStatsFixture().data[0];
    if (base === undefined) throw new Error("Fixture must contain a player.");
    const response: PlayerStatsResponse = {
      draw: 0,
      recordsTotal: 2,
      recordsFiltered: 2,
      data: [
        { ...base, player_key: 2001, player_name: "Michael Smith", player_profile_url: "https://dartsorakel.com/player/details/2001/michael-smith" },
        { ...base, player_key: 2002, player_name: "Ross Smith", player_profile_url: "https://dartsorakel.com/player/details/2002/ross-smith" },
      ],
    };

    await expect(resolverFor(response).resolvePlayer("smith")).rejects.toBeInstanceOf(PlayerAmbiguousError);
  });
});
