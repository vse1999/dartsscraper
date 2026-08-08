import type { DartsOrakelClient } from "./client.js";
import { parseDartsOrakelMatches } from "./parser.js";
import type { Match } from "../schemas/match.js";
import type { PlayerIdentity } from "../schemas/player.js";

export class DartsOrakelScraper {
  private readonly client: Pick<DartsOrakelClient, "getPlayerMatches">;

  public constructor(client: Pick<DartsOrakelClient, "getPlayerMatches">) {
    this.client = client;
  }

  public async getPlayerMatches(player: PlayerIdentity): Promise<Match[]> {
    const response = await this.client.getPlayerMatches(player.id);
    return parseDartsOrakelMatches(player, response);
  }
}
