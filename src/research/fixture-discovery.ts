import { DartsOrakelClient } from "../dartsorakel/client.js";
import { FixtureNameResolver } from "../modus/fixture-name-resolver.js";
import { OfficialModusSource } from "../modus/official-source.js";
import { DartsNerdModusSource } from "../modus/darts-nerd-source.js";
import { ModusPlayersService } from "../modus/service.js";
import { createDefaultPdcTournamentService } from "../pdc/default.js";
import { noopLogger } from "../logger.js";
import { buildFixtureInventory, type FixtureInventoryDraft, type FixtureInventorySource } from "./fixture-inventory.js";

/** Existing source adapters only; no fallback to the expensive full research report. */
export function createFixtureDiscovery(client: DartsOrakelClient, source: FixtureInventorySource, date: string, sharedResolver?: FixtureNameResolver): (signal: AbortSignal) => Promise<FixtureInventoryDraft> {
  const resolver = sharedResolver ?? new FixtureNameResolver(client);
  if (source === "pdc") {
    const service = createDefaultPdcTournamentService(noopLogger, undefined, undefined, client, resolver);
    return async (signal: AbortSignal): Promise<FixtureInventoryDraft> => buildFixtureInventory("pdc", date, await service.getFixturesForDate(date, signal));
  }
  const fixtures = new ModusPlayersService({ sources: [new OfficialModusSource({ resolver }), new DartsNerdModusSource({ resolver })] });
  return async (signal: AbortSignal): Promise<FixtureInventoryDraft> => buildFixtureInventory("modus", date, (await fixtures.getModusFixtures(date, signal)).fixtures);
}
