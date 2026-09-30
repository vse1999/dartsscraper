import { describe, expect, it } from "vitest";
import { parseEredmenyekMatchIdentity, parseEredmenyekPlayerProfile } from "../src/odds/identity.js";
import { createDefaultOddsReader } from "../src/odds/default.js";

const detailUrl = "https://www.eredmenyek.com/merkozes/darts/menzies-cameron-2NUpDqVt/smith-ross-l8mIsYNm/?mid=p26kVvmS";

function detailHtml(title = "Ross Smith v Cameron Menzies (28/09/2026)"): string {
  return `<html><body><main><h1>${title}</h1>
    <a href="/jatekos/smith-ross/l8mIsYNm/">Smith R.</a>
    <a href="/jatekos/menzies-cameron/2NUpDqVt/">Menzies C.</a>
    <a href="/jatekos/smith-ross/l8mIsYNm/"></a>
  </main></body></html>`;
}

function swappedDetailHtml(): string {
  return `<html><body><main><h1>Ross Smith v Cameron Menzies (28/09/2026)</h1>
    <a href="/jatekos/menzies-cameron/2NUpDqVt/">Menzies C.</a>
    <a href="/jatekos/smith-ross/l8mIsYNm/">Smith R.</a>
  </main></body></html>`;
}

describe("Eredmenyek match identity evidence", () => {
  it("uses DOM participant order rather than reversed detail URL slug order", () => {
    const evidence = parseEredmenyekMatchIdentity({
      html: detailHtml(),
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    });
    expect(evidence.home).toEqual({
      sourcePlayerId: "l8mIsYNm",
      fullName: "Ross Smith",
      profileUrl: "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/",
    });
    expect(evidence.away.sourcePlayerId).toBe("2NUpDqVt");
  });

  it("matches swapped profile anchors by their verified participant labels", () => {
    const evidence = parseEredmenyekMatchIdentity({
      html: swappedDetailHtml(),
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    });
    expect(evidence.home.sourcePlayerId).toBe("l8mIsYNm");
    expect(evidence.away.sourcePlayerId).toBe("2NUpDqVt");
  });

  it("rejects a source ID whose DOM label disagrees with its verified profile page", () => {
    const html = `<html><body><main><h1>Ross Smith v Cameron Menzies (28/09/2026)</h1>
      <a href="/jatekos/raymond-smith/raymond-id/">Smith R.</a>
      <a href="/jatekos/menzies-cameron/2NUpDqVt/">Menzies C.</a>
    </main></body></html>`;
    expect(() => parseEredmenyekMatchIdentity({
      html,
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
      verifiedProfiles: [
        { sourcePlayerId: "raymond-id", fullName: "Raymond Smith", profileUrl: "https://www.eredmenyek.com/jatekos/raymond-smith/raymond-id/" },
        { sourcePlayerId: "2NUpDqVt", fullName: "Cameron Menzies", profileUrl: "https://www.eredmenyek.com/jatekos/menzies-cameron/2NUpDqVt/" },
      ],
    })).toThrow(/displayed odds participant|missing a participant profile|profile page/iu);
  });

  it("rejects conflicting full labels repeated for one source profile ID", () => {
    const html = detailHtml().replace(">Smith R.</a>", ">Ross Smith</a>").replace("<a href=\"/jatekos/smith-ross/l8mIsYNm/\"></a>", "<a href=\"/jatekos/smith-ross/l8mIsYNm/\">Raymond Smith</a>");
    expect(() => parseEredmenyekMatchIdentity({
      html,
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    })).toThrow(/conflicting labels/iu);
  });

  it("fails closed when an unrelated third profile appears in the detail participants", () => {
    expect(() => parseEredmenyekMatchIdentity({
      html: `${swappedDetailHtml().replace("</main>", "<a href=\"/jatekos/anderson-gary/MyKZZS6r/\">Anderson G.</a></main>")}`,
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    })).toThrow(/exactly two/iu);
  });

  it("fails closed when the detail date does not match the report date", () => {
    expect(() => parseEredmenyekMatchIdentity({
      html: detailHtml(),
      detailUrl,
      date: "2026-09-29",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    })).toThrow(/date/iu);
  });

  it("fails closed when full heading names do not match displayed slots", () => {
    expect(() => parseEredmenyekMatchIdentity({
      html: detailHtml("Ross Smith v Gary Anderson (28/09/2026)"),
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    })).toThrow(/displayed odds participant|missing a participant profile/iu);
  });

  it("verifies a public profile full name and canonical source ID", () => {
    const profileUrl = "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/";
    const profile = parseEredmenyekPlayerProfile({
      profileUrl,
      html: `<head><link rel="canonical" href="${profileUrl}"></head><main><h1>Darts: Ross Smith eredmények, meccsek</h1><div class="heading__name">Ross Smith</div></main>`,
    });
    expect(profile).toEqual({ sourcePlayerId: "l8mIsYNm", fullName: "Ross Smith", profileUrl });
  });

  it("rejects conflicting profile headings and canonical IDs", () => {
    const profileUrl = "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/";
    expect(() => parseEredmenyekPlayerProfile({
      profileUrl,
      html: `<head><link rel="canonical" href="${profileUrl.replace("l8mIsYNm", "other-id")}"></head><main><h1>Darts: Ross Smith eredmények, meccsek</h1><div class="heading__name">Raymond Smith</div></main>`,
    })).toThrow(/conflicting full-name headings|canonical/iu);
  });

  it("does not queue browser work for an already-aborted identity request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("identity request already cancelled"));
    const reader = createDefaultOddsReader({ executablePath: "C:/does-not-exist/chrome.exe" });
    await expect(reader.getIdentityEvidence([], "2026-09-28", controller.signal)).rejects.toThrow(/already cancelled/iu);
  });
});
