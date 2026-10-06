import { describe, expect, it } from "vitest";
import { isOfflineTestUrl } from "./helpers/offline-fetch.js";

describe("offline verification fetch boundary", () => {
  it("permits literal loopback, not DNS names, credentials or external providers", () => {
    expect(isOfflineTestUrl("http://127.0.0.1:8080/health")).toBe(true);
    expect(isOfflineTestUrl("http://[::1]:8080/")).toBe(true);
    expect(isOfflineTestUrl("https://dartsorakel.com/")).toBe(false);
    expect(isOfflineTestUrl("http://localhost.example.test/")).toBe(false);
    expect(isOfflineTestUrl("http://user:secret@127.0.0.1/")).toBe(false);
  });
  it("fails before unmocked source or Telegram requests can be sent", async () => {
    await expect(fetch("https://dartsorakel.com/api/stats/player")).rejects.toThrow("unmocked external fetch");
    await expect(fetch("https://api.telegram.org/bot-not-a-token/sendMessage")).rejects.toThrow("unmocked external fetch");
  });
});
