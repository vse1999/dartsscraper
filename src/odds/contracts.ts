export type OddsDay = "today" | "tomorrow";

export interface OddsReader {
  getOdds(day: OddsDay, signal?: AbortSignal): Promise<OddsReport>;
}

export interface OddsReport {
  readonly source: "eredmenyek";
  readonly sourceUrl: string;
  readonly observedAt: string;
  /** Local calendar date represented by the source UI. */
  readonly date: string;
  readonly timeZone: "Europe/Budapest";
  readonly matches: readonly OddsMatch[];
  readonly warnings: readonly string[];
}

export interface OddsMatch {
  readonly eventId: string;
  readonly competition: string;
  /** Displayed home participant; do not infer order from the detail URL. */
  readonly player1: string;
  /** Displayed away participant; do not infer order from the detail URL. */
  readonly player2: string;
  readonly odds1: number;
  readonly odds2: number;
  readonly bookmaker: "TippmixPro";
  /** Displayed local HH:mm value, intentionally not converted to UTC. */
  readonly scheduledTime: string;
  readonly sourceUrl: string;
  /**
   * Optional identity evidence captured from this exact Eredmenyek match
   * detail. It is intentionally absent on parsed table-only observations.
   */
  readonly identityEvidence?: OddsMatchIdentityEvidence;
}

export interface OddsMatchIdentityEvidence {
  readonly eventId: string;
  /** Local Budapest calendar date shown by the match detail. */
  readonly date: string;
  readonly home: OddsParticipantIdentityEvidence;
  readonly away: OddsParticipantIdentityEvidence;
}

export interface OddsParticipantIdentityEvidence {
  /** Opaque profile identifier owned by Eredmenyek; never use the slug as an ID. */
  readonly sourcePlayerId: string;
  /** Full name verified on the same match detail or profile page. */
  readonly fullName: string;
  readonly profileUrl: string;
}

export interface OddsIdentityReader {
  /** Optional bounded batch capacity. Omitted means the provider has no declared cap. */
  readonly maxIdentityEvidenceMatches?: number;
  /**
   * Reads only exact detail URLs already present in the odds table. The date
   * is supplied by the enclosing odds report so stale/cross-match evidence is
   * rejected rather than silently joined.
   */
  getIdentityEvidence(
    matches: readonly OddsMatch[],
    date: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>>;
}
