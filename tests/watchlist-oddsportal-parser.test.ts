import { describe, expect, it } from "vitest";

import {
  OddsPortalParserError,
  parseOddsPortalRenderedTable,
  type OddsPortalRenderedInput,
} from "../src/watchlist/oddsportal-parser.js";

const SOURCE_URL = "https://www.oddsportal.com/darts/h2h/owens-jamie-WbmpecDb/taylor-scott-Gbhioxp4/#hYdXZjTN";
const OBSERVED_AT = "2026-09-25T20:00:00+02:00";

function input(table: string): OddsPortalRenderedInput {
  return { html: `<main><h1>Taylor S. - Owens J.</h1>${table}</main>`, sourceUrl: SOURCE_URL, observedAt: OBSERVED_AT };
}

// Synthetic minimal DOM fixture: the inspected OddsPortal URL is structural reference only; names and prices are fabricated.
function table(rows: string): string {
  return `<table><thead><tr><th>Bookmakers</th><th>1</th><th>2</th><th>Payout</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function row(slug: string, name: string, first: string, second: string): string {
  return `<tr><td><a href="/proxy/bookmakers/${slug}/link/"><img alt="Bookmaker"></a><a href="/bookmakers/${slug}/"><p>${name}</p></a><a aria-label="Review" href="/bookmakers/${slug}/"></a><a href="/proxy/bookmakers/${slug}/bonus/1045/">claim bonus</a></td><td><div><a href="/proxy/bookmakers/${slug}/betslip/p/Darts/...">${first}</a></div></td><td><div><a href="/proxy/bookmakers/${slug}/betslip/p/Darts/...">${second}</a></div></td><td>92.5%</td></tr>`;
}

describe("OddsPortal rendered table parser", () => {
  it("returns raw bookmaker-attributed paired columns without inferring players or active market metadata", () => {
    const parsed = parseOddsPortalRenderedTable(input(table([
      row("1xbet", "1xBet", "2.39", "1.51"),
      row("stake", "Stake.com", "2.40", "1.50"),
    ].join(""))));

    expect(parsed.clean).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.quotes.map((quote) => quote.bookmakerSlug)).toEqual(["1xbet", "stake"]);
    expect(parsed.quotes[0]).toMatchObject({
      bookmakerName: "1xBet",
      sourceUrl: SOURCE_URL,
      observedAt: OBSERVED_AT,
      marketType: "two_outcome_unverified",
      marketStatus: "unverified",
      eventStatus: null,
      round: null,
      scheduledStart: null,
      sourceUpdatedAt: null,
      playerMappingStatus: "unknown",
    });
    expect(parsed.quotes[0]?.selection1).toMatchObject({ column: "1", decimalPrice: 2.39 });
    expect(parsed.quotes[0]?.selection2).toMatchObject({ column: "2", decimalPrice: 1.51 });
    expect(parsed.quotes.map((quote) => quote.bookmakerName)).not.toContain("Tippmixpro");
  });

  it("fails closed for a JavaScript shell and for unsupported or ambiguous tables", () => {
    const shell = parseOddsPortalRenderedTable(input("<div id=\"app\"></div>"));
    expect(shell.clean).toBe(false);
    expect(shell.issues[0]?.code).toBe("html_shell_no_market_table");

    const unsupported = parseOddsPortalRenderedTable(input("<table><tr><th>Bookmakers</th><th>1X2</th><th>Over/Under</th></tr></table>"));
    expect(unsupported.issues[0]?.code).toBe("unsupported_or_missing_headings");

    const valid = table(row("1xbet", "1xBet", "2.39", "1.51"));
    const ambiguous = parseOddsPortalRenderedTable(input(`${valid}${valid}`));
    expect(ambiguous.issues[0]?.code).toBe("ambiguous_market_tables");
  });

  it("reports malformed, disabled, duplicate and empty rows instead of silently truncating them", () => {
    const disabled = row("1xbet", "1xBet", "2.39", "1.51").replace("<tr>", "<tr class=\"suspended\">");
    const duplicate = row("1xbet", "1xBet", "2.40", "1.50");
    const malformed = row("stake", "Stake.com", "N/A", "1.50");
    const result = parseOddsPortalRenderedTable(input(table(`${disabled}${duplicate}${malformed}`)));
    expect(result.clean).toBe(false);
    expect(result.quotes).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "disabled_or_suspended_odds",
      "duplicate_bookmaker",
      "invalid_decimal",
    ]);
  });

  it("rejects inactive/non-decimal odds and unexpected row shapes", () => {
    const inactive = row("1xbet", "1xBet", "", "1.51");
    const wrongShape = "<tr><td><p>Stake.com</p></td><td>2.20</td><td>1.60</td></tr>";
    const result = parseOddsPortalRenderedTable(input(table(`${inactive}${wrongShape}`)));
    expect(result.issues.map((issue) => issue.code)).toEqual(["empty_decimal", "row_shape_mismatch"]);
  });

  it("rejects bookmaker identity conflicts in labels or odds links and honors aria-disabled", () => {
    const ariaDisabled = row("1xbet", "1xBet", "2.39", "1.51").replace("<tr>", "<tr aria-disabled=\"true\">");
    const conflictingLabel = row("1xbet", "1xBet", "2.39", "1.51").replace("/bookmakers/1xbet/\"><p>", "/bookmakers/other/\"><p>");
    const conflictingOddsLink = row("stake", "Stake.com", "2.39", "1.51").replace("/proxy/bookmakers/stake/betslip", "/proxy/bookmakers/other/betslip");
    const result = parseOddsPortalRenderedTable(input(table(`${ariaDisabled}${conflictingLabel}${conflictingOddsLink}`)));
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "disabled_or_suspended_odds",
      "bookmaker_identity_conflict",
      "bookmaker_identity_conflict",
    ]);
  });

  it("rejects an off-site numeric odds anchor instead of attributing it", () => {
    const offsite = row("1xbet", "1xBet", "2.39", "1.51").replace(
      "/proxy/bookmakers/1xbet/betslip",
      "https://example.test/odds",
    );
    const result = parseOddsPortalRenderedTable(input(table(offsite)));

    expect(result.clean).toBe(false);
    expect(result.quotes).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["bookmaker_identity_conflict"]);
  });

  it("requires the HTTPS OddsPortal darts allowlist and bounded input", () => {
    expect(() => parseOddsPortalRenderedTable({ ...input(table(row("1xbet", "1xBet", "2.39", "1.51"))), sourceUrl: "https://example.com/darts/" })).toThrow(OddsPortalParserError);
    expect(() => parseOddsPortalRenderedTable({ ...input(table(row("1xbet", "1xBet", "2.39", "1.51"))), sourceUrl: "https://www.oddsportal.com/darts/%2e%2e/football/" })).toThrow(/traversal/);
    expect(() => parseOddsPortalRenderedTable({ ...input(table(row("1xbet", "1xBet", "2.39", "1.51"))), observedAt: "not-a-date" })).toThrow(OddsPortalParserError);
    expect(() => parseOddsPortalRenderedTable({ ...input(table(row("1xbet", "1xBet", "2.39", "1.51"))), html: "x".repeat(1_000_001) })).toThrow(OddsPortalParserError);
  });
});
