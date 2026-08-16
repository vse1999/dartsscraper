import { describe, expect, it } from "vitest";

import { createJinaReaderFetch } from "../src/dartsorakel/reader-fetch.js";

function readerWrapper(content: string, httpStatus = 200): object {
  return {
    code: 200,
    status: 200,
    data: { content, httpStatus },
  };
}

describe("Jina Reader DartsOrakel transport", () => {
  it("unwraps public DartsOrakel JSON", async () => {
    let requestedUrl: string | undefined;
    let acceptHeader: string | null = null;
    const transport = createJinaReaderFetch({
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestedUrl = String(input);
        acceptHeader = new Headers(init?.headers).get("accept");
        return Response.json(readerWrapper('  {"data":[1]}  '));
      },
    });

    const response = await transport("https://dartsorakel.com/api/example?limit=10");

    expect(requestedUrl).toBe("https://r.jina.ai/https://dartsorakel.com/api/example?limit=10");
    expect(acceptHeader).toBe("application/json");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [1] });
  });

  it("preserves the source status encoded by Reader", async () => {
    const transport = createJinaReaderFetch({
      fetchImpl: async (): Promise<Response> => Response.json(readerWrapper("forbidden", 403)),
    });

    const response = await transport("https://dartsorakel.com/api/example");
    expect(response.status).toBe(403);
  });

  it("propagates Reader rate limiting", async () => {
    const transport = createJinaReaderFetch({
      fetchImpl: async (): Promise<Response> => new Response(null, {
        status: 429,
        headers: { "retry-after": "5" },
      }),
    });

    const response = await transport("https://dartsorakel.com/api/example");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("rejects non-DartsOrakel targets and malformed wrappers", async () => {
    const transport = createJinaReaderFetch({
      fetchImpl: async (): Promise<Response> => Response.json({ unexpected: true }),
    });

    await expect(transport("https://example.com/private")).rejects.toThrow("only permits");
    await expect(transport("https://dartsorakel.com/api/example")).rejects.toThrow("unexpected response shape");
  });
});
