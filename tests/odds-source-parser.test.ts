import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatEredmenyekDateLabel, parseEredmenyekRenderedOdds, EredmenyekOddsParserError } from "../src/odds/parser.js";

const SOURCE_URL = "https://www.eredmenyek.com/darts/oddsok/";
const REQUESTED_DATE = "2026-09-30";
const OBSERVED_AT = "2026-09-30T11:00:00.000Z";
const DATE_LABEL = formatEredmenyekDateLabel(REQUESTED_DATE);

function input(html: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    html,
    sourceUrl: SOURCE_URL,
    observedAt: OBSERVED_AT,
    requestedDate: REQUESTED_DATE,
    dateLabel: DATE_LABEL,
    bookmakerMappingValidated: true,
    ...overrides,
  };
}

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("Eredmenyek rendered odds parser", () => {
  it("maps displayed participant order and TippmixPro 498 odds", () => {
    const result = parseEredmenyekRenderedOdds(input(fixture("eredmenyek-scheduled.html")));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      eventId: "good01",
      player1: "Player One",
      player2: "Player Two",
      odds1: 1.8,
      odds2: 2.2,
      bookmaker: "TippmixPro",
      scheduledTime: "20:10",
      sourceUrl: "https://www.eredmenyek.com/merkozes/darts/player-one/good01/?mid=good01",
    });
  });

  it("quarantines every copy of a conflicting duplicate event id", () => {
    const result = parseEredmenyekRenderedOdds(input(fixture("eredmenyek-duplicate.html")));
    expect(result.matches).toEqual([]);
    expect(result.warnings.some((warning: string): boolean => warning.includes("duplicate"))).toBe(true);
  });

  it("keeps a valid scheduled row when neighboring rows are live or missing odds", () => {
    const valid = fixture("eredmenyek-scheduled.html");
    const neighbors = `<div class="event__match event__match--live" id="g_14_live01"><a class="eventRowLink" href="/merkozes/darts/live/live01/?mid=live01"></a><div class="event__participant--home">Live A</div><div class="event__participant--away">Live B</div><div class="event__time">19:10</div></div><div class="event__match event__match--scheduled" id="g_14_missing01"><a class="eventRowLink" href="/merkozes/darts/missing/missing01/?mid=missing01"></a><div class="event__participant--home">Missing A</div><div class="event__participant--away">Missing B</div><div class="event__time">22:10</div></div>`;
    const mixed = valid.replace("  </div>\n</div>", `${neighbors}  </div>\n</div>`);
    const result = parseEredmenyekRenderedOdds(input(mixed));
    expect(result.matches.map((match) => match.eventId)).toEqual(["good01"]);
    expect(result.warnings).toHaveLength(2);
  });

  it("fails closed for changed wrappers and accepts only explicit empty markers", () => {
    const changed = fixture("eredmenyek-scheduled.html").replace("<div class=\"event__match event__match--scheduled\"", "<section class=\"changed-row\"");
    expect(() => parseEredmenyekRenderedOdds(input(changed))).toThrow(EredmenyekOddsParserError);

    const empty = `<div id="live-table"><div class="filters__tab selected" data-analytics-alias="odds">Oddsok</div><button data-testid="wcl-dayPickerButton" aria-label="${DATE_LABEL}">Dátum</button><div class="emptyState">Nincsenek mérkőzések</div></div>`;
    expect(parseEredmenyekRenderedOdds(input(empty)).matches).toEqual([]);
  });

  it("rejects malformed links, duplicate mid keys, wrong bookmaker ids, and ambiguous nodes", () => {
    const valid = fixture("eredmenyek-scheduled.html");
    expect(parseEredmenyekRenderedOdds(input(valid.replace("?mid=good01", "?mid=good01&mid=good01"))).matches).toEqual([]);
    expect(parseEredmenyekRenderedOdds(input(valid.replace('data-bookmaker-id="498"', 'data-bookmaker-id="497"'))).matches).toEqual([]);
    expect(parseEredmenyekRenderedOdds(input(valid.replace("<div class=\"event__time\">", "<div class=\"event__time\">20:10</div><div class=\"event__time\">"))).matches).toEqual([]);
    expect(() => parseEredmenyekRenderedOdds(input(valid, { sourceUrl: "https://user:pass@www.eredmenyek.com/darts/oddsok/" }))).toThrow(EredmenyekOddsParserError);
  });
});
