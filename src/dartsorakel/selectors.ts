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

// Values observed on the live player matches page when the table shows the
// complete "Averages" view. Omitting organStat makes the API silently return
// only a subset of competitions for some players.
export const DartsOrakelMatchDefaults = {
  rankKey: "25",
  organStat: "All",
  tournaments: "",
} as const;

export const DartsOrakelPlayerProfilePattern = /\/player\/details\/(\d+)\/([^/?#]+)/i;
