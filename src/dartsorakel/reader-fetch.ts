import { z } from "zod";

const JINA_READER_ORIGIN = "https://r.jina.ai";
const DARTSORAKEL_ORIGIN = "https://dartsorakel.com";

const JinaReaderResponseSchema = z.object({
  data: z.object({
    content: z.string(),
    httpStatus: z.number().int().min(100).max(599),
  }),
});

export interface JinaReaderFetchOptions {
  readonly fetchImpl?: typeof fetch;
}

/**
 * Fetches public DartsOrakel JSON through Jina Reader. Vercel's datacenter
 * addresses receive a Cloudflare managed challenge from DartsOrakel, while
 * Reader is explicitly designed to retrieve public URLs and has a free tier.
 */
export function createJinaReaderFetch(options: JinaReaderFetchOptions = {}): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = requestUrl(input);
    if (target.origin !== DARTSORAKEL_ORIGIN) {
      throw new Error("Jina Reader transport only permits HTTPS requests to dartsorakel.com.");
    }

    const method = requestMethod(input, init);
    if (method !== "GET") {
      throw new Error("Jina Reader transport only supports GET requests.");
    }

    const readerUrl = `${JINA_READER_ORIGIN}/${target.toString()}`;
    const response = await fetchImpl(readerUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
    });
    if (!response.ok) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: copyRetryHeaders(response.headers),
      });
    }

    const wrapper: unknown = await response.json();
    const parsed = JinaReaderResponseSchema.safeParse(wrapper);
    if (!parsed.success) {
      throw new Error("Jina Reader returned an unexpected response shape.");
    }

    const content = parsed.data.data.content.trim();
    if (content === "") {
      throw new Error("Jina Reader returned an empty DartsOrakel response.");
    }
    return new Response(content, {
      status: parsed.data.data.httpStatus,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Jina Reader transport requires HTTPS.");
  }
  return url;
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

function copyRetryHeaders(headers: Headers): HeadersInit {
  const retryAfter = headers.get("retry-after");
  return retryAfter === null ? {} : { "retry-after": retryAfter };
}
