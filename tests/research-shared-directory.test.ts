import { describe, expect, it, vi } from "vitest";
import { FixtureNameResolver } from "../src/modus/fixture-name-resolver.js";
import type { PlayerStatsResponse } from "../src/schemas/player.js";

function directory(url: string = "https://dartsorakel.com/player/details/42/alice-example"): PlayerStatsResponse {
  return { draw: 1, recordsTotal: 1, recordsFiltered: 1,
    data: [{ player_key: 42, player_name: "Alice Example", player_profile_url: url }] };
}
describe("shared strict fixture directory", () => {
  it("reuses discovery resolution for history identity without a second directory request", async () => {
    const load = vi.fn(async (): Promise<PlayerStatsResponse> => directory());
    const resolver = new FixtureNameResolver({ getPlayerStats: load });
    expect(await resolver.resolve("Example, Alice")).toBe("Alice Example");
    expect(await resolver.resolvePlayerIdentity("Alice Example")).toEqual({ id: 42, name: "Alice Example", slug: "alice-example" });
    expect(await resolver.resolvePlayerIdentity("Example A.")).toEqual({ id: 42, name: "Alice Example", slug: "alice-example" });
    expect(load).toHaveBeenCalledOnce();
  });
  it("rejects a foreign profile host and an inconsistent profile ID", async () => {
    const foreign = new FixtureNameResolver({ getPlayerStats: async (): Promise<PlayerStatsResponse> => directory("https://foreign.test/player/details/42/alice-example") });
    await expect(foreign.resolvePlayerIdentity("Alice Example")).rejects.toThrow("untrusted");
    const mismatched = new FixtureNameResolver({ getPlayerStats: async (): Promise<PlayerStatsResponse> => directory("https://dartsorakel.com/player/details/99/alice-example") });
    await expect(mismatched.resolvePlayerIdentity("Alice Example")).rejects.toThrow("does not match");
  });
});
