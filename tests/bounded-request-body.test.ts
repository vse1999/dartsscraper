import { describe, expect, it } from "vitest";

import { readBoundedRequestBody } from "../src/services/bounded-request-body.js";

describe("readBoundedRequestBody", (): void => {
  it("reads UTF-8 bodies within the byte limit", async (): Promise<void> => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: new TextEncoder().encode("darts 🎯"),
    });

    await expect(readBoundedRequestBody(request, 16)).resolves.toEqual({ kind: "ok", text: "darts 🎯" });
  });

  it("rejects a declared oversize body without reading the stream", async (): Promise<void> => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulled = true;
        controller.enqueue(new TextEncoder().encode("too much"));
      },
    }, { highWaterMark: 0 });
    const requestOptions: RequestInit & { readonly duplex: "half" } = {
      method: "POST",
      headers: { "content-length": "100" },
      body,
      duplex: "half",
    };
    const request = new Request("https://example.test", requestOptions);

    await expect(readBoundedRequestBody(request, 10)).resolves.toEqual({ kind: "too-large" });
    expect(pulled).toBe(false);
  });

  it("cancels a streamed body as soon as its byte limit is crossed", async (): Promise<void> => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls += 1;
        controller.enqueue(new Uint8Array(6));
      },
      cancel(): void {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const requestOptions: RequestInit & { readonly duplex: "half" } = { method: "POST", body, duplex: "half" };
    const request = new Request("https://example.test", requestOptions);

    await expect(readBoundedRequestBody(request, 10)).resolves.toEqual({ kind: "too-large" });
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });

  it("rejects malformed content-length headers and invalid limits", async (): Promise<void> => {
    const malformed = new Request("https://example.test", {
      method: "POST",
      headers: { "content-length": "10x" },
      body: "{}",
    });
    await expect(readBoundedRequestBody(malformed, 10)).resolves.toEqual({ kind: "too-large" });
    await expect(readBoundedRequestBody(new Request("https://example.test"), 0)).rejects.toThrow("positive safe integer");
  });
});
