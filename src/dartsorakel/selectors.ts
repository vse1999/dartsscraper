export const DartsOrakelApiPath = {
  playerStats: "/api/stats/player",
  playerMatches: (playerId: number): string => `/api/player/matches/${playerId}`,
} as const;

export const DartsOrakelMatchQuery = {
  dateFrom: "dateFrom",
  dateTo: "dateTo",
  rankKey: "rankKey",
  organStat: "organStat",
  tournaments: "tourns",
} as const;

export const DartsOrakelPlayerProfilePattern = /\/player\/details\/(\d+)\/([^/?#]+)/i;
