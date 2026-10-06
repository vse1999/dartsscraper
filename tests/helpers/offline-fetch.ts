/** Real test HTTP is loopback-only. Source and Telegram transports must be mocked. */
export function isOfflineTestUrl(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return (url.protocol === "http:" || url.protocol === "https:")
      && ["127.0.0.1", "[::1]"].includes(url.hostname)
      && url.username === "" && url.password === "";
  } catch { return false; }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isOfflineTestUrl(input)) throw new Error("Offline verification blocked an unmocked external fetch. Supply a fixture transport; no source or Telegram request was sent.");
  // Even a loopback test server cannot redirect a real request to an external service.
  return originalFetch(input, { ...init, redirect: "error" });
};
