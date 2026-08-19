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

export const DartsOrakelMatchStatistic = {
  average: "average",
  oneEighties: "oneEighties",
  checkoutPercentage: "checkoutPercentage",
} as const;

export type DartsOrakelMatchStatistic =
  typeof DartsOrakelMatchStatistic[keyof typeof DartsOrakelMatchStatistic];

export const DartsOrakelMatchRankKey: Readonly<Record<DartsOrakelMatchStatistic, string>> = {
  average: "25",
  oneEighties: "26",
  checkoutPercentage: "1053",
};

// Values observed on the live player matches page. Omitting organStat makes
// the API silently return only a subset of competitions for some players.
export const DartsOrakelMatchDefaults = {
  rankKey: DartsOrakelMatchRankKey.average,
  organStat: "All",
  tournaments: "",
} as const;

export const DartsOrakelPlayerProfilePattern = /\/player\/details\/(\d+)\/([^/?#]+)/i;
