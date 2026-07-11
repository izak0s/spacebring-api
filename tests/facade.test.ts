import { describe, expect, it } from "vitest";
import { Spacebring, SpacebringError } from "../src/index.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

function mockClient(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
  config?: { networkId?: string; maxRetries?: number },
) {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const fetch = async (input: Request | string | URL): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next.body === undefined) {
      return new Response(null, { status: next.status, headers: next.headers });
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  };
  const sb = new Spacebring({
    clientId: "client id",
    clientSecret: "client secret",
    networkId: config?.networkId,
    maxRetries: config?.maxRetries,
    fetch: fetch as typeof globalThis.fetch,
  });
  return { sb, requests };
}

describe("Spacebring client", () => {
  it("sends Basic auth and network id headers to the right endpoint", async () => {
    const { sb, requests } = mockClient([{ status: 200, body: { benefit: { id: "b1" } } }], { networkId: "net-1" });
    const benefit = await sb.benefits.get("b1");
    expect(benefit).toEqual({ id: "b1" }); // single-property envelope is unwrapped

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe("https://api.spacebring.com/benefits/v1/b1");
    // Matches the documented example encoding of "client id:client secret".
    expect(requests[0].headers.get("authorization")).toBe("Basic Y2xpZW50IGlkOmNsaWVudCBzZWNyZXQ=");
    expect(requests[0].headers.get("spacebring-network-id")).toBe("net-1");
  });

  it("rejects an http baseUrl so Basic-auth credentials are never sent in cleartext", () => {
    const fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
    expect(() => new Spacebring({ clientId: "a", clientSecret: "b", baseUrl: "http://api.spacebring.com", fetch })).toThrow(
      /must use https/,
    );
  });

  it("allows an http baseUrl for loopback hosts (local proxy/mock)", () => {
    const fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
    expect(() => new Spacebring({ clientId: "a", clientSecret: "b", baseUrl: "http://localhost:3000", fetch })).not.toThrow();
    expect(() => new Spacebring({ clientId: "a", clientSecret: "b", baseUrl: "http://127.0.0.1:3000", fetch })).not.toThrow();
  });

  it("rejects a malformed baseUrl", () => {
    const fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
    expect(() => new Spacebring({ clientId: "a", clientSecret: "b", baseUrl: "not a url", fetch })).toThrow(/not a valid URL/);
  });

  it("omits the network id header when not configured", async () => {
    const { sb, requests } = mockClient([{ status: 200, body: { benefits: [] } }]);
    await sb.benefits.list();
    expect(requests[0].headers.get("spacebring-network-id")).toBeNull();
  });

  it("serializes query parameters", async () => {
    const { sb, requests } = mockClient([{ status: 200, body: { benefits: [] } }]);
    await sb.benefits.list({ locationRef: "loc-1", limit: 50 });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/benefits/v1");
    expect(url.searchParams.get("locationRef")).toBe("loc-1");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("sends JSON bodies on create and action endpoints", async () => {
    const { sb, requests } = mockClient([{ status: 200, body: {} }]);
    await sb.billing.invoices.pay("inv-1", { paymentMethod: { type: "stripe" } });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("https://api.spacebring.com/billing/invoices/v1/inv-1/pay");
    expect(requests[0].headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(requests[0].body)).toEqual({ paymentMethod: { type: "stripe" } });
  });

  it("throws SpacebringError with status, body, and the operation on API errors", async () => {
    const { sb } = mockClient([{ status: 400, body: { message: "locationRef is required", type: "invalid_request" } }]);
    const failure = sb.benefits.list();
    await expect(failure).rejects.toBeInstanceOf(SpacebringError);
    await expect(failure).rejects.toMatchObject({
      status: 400,
      message: "locationRef is required (GET /benefits/v1)",
      body: { type: "invalid_request" },
      operation: "GET /benefits/v1",
    });
  });

  it("resolves 204 no-content responses without throwing", async () => {
    const { sb, requests } = mockClient([{ status: 204 }]);
    await expect(sb.benefits.delete("b1")).resolves.toBeUndefined();
    expect(requests[0].method).toBe("DELETE");
  });

  it("iterate follows nextPageToken across pages", async () => {
    const { sb, requests } = mockClient([
      { status: 200, body: { benefits: [{ id: "b1" }, { id: "b2" }], nextPageToken: "page-2" } },
      { status: 200, body: { benefits: [{ id: "b3" }] } },
    ]);

    const ids: string[] = [];
    for await (const benefit of sb.benefits.iterate({ locationRef: "loc-1" })) {
      ids.push(benefit.id);
    }

    expect(ids).toEqual(["b1", "b2", "b3"]);
    expect(requests).toHaveLength(2);
    const secondPage = new URL(requests[1].url);
    expect(secondPage.searchParams.get("nextPageToken")).toBe("page-2");
    expect(secondPage.searchParams.get("locationRef")).toBe("loc-1");
  });

  it("retries rate-limited requests and resends the body", async () => {
    const rateLimited = { status: 429, body: { message: "rate limited" }, headers: { "Retry-After": "0" } };
    const { sb, requests } = mockClient([rateLimited, rateLimited, { status: 200, body: { benefit: { id: "b1" } } }]);
    const created = await sb.benefits.create({ locationRef: "loc-1", title: "Coffee" } as never);
    expect(created).toMatchObject({ benefit: { id: "b1" } });
    expect(requests).toHaveLength(3);
    // Request bodies are one-shot streams; each retry must carry a fresh clone.
    expect(JSON.parse(requests[2].body)).toEqual(JSON.parse(requests[0].body));
  });

  it("gives up after maxRetries and throws the 429", async () => {
    const rateLimited = { status: 429, body: { message: "rate limited" }, headers: { "Retry-After": "0" } };
    const { sb, requests } = mockClient([rateLimited], { maxRetries: 1 });
    await expect(sb.benefits.list()).rejects.toMatchObject({ status: 429 });
    expect(requests).toHaveLength(2);
  });

  it("does not retry when maxRetries is 0", async () => {
    const { sb, requests } = mockClient([{ status: 429, body: {} }], { maxRetries: 0 });
    await expect(sb.benefits.list()).rejects.toMatchObject({ status: 429 });
    expect(requests).toHaveLength(1);
  });

  it("retries idempotent requests on gateway errors", async () => {
    const { sb, requests } = mockClient([
      { status: 503, body: {}, headers: { "Retry-After": "0" } },
      { status: 200, body: { benefits: [] } },
    ]);
    await expect(sb.benefits.list()).resolves.toEqual({ benefits: [] });
    expect(requests).toHaveLength(2);
  });

  it("does not replay POSTs on gateway errors", async () => {
    const { sb, requests } = mockClient([{ status: 502, body: {} }]);
    await expect(sb.benefits.create({} as never)).rejects.toMatchObject({ status: 502 });
    expect(requests).toHaveLength(1);
  });

  it("retries network errors on idempotent requests", async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ benefits: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const sb = new Spacebring({ clientId: "a", clientSecret: "b", fetch: fetch as typeof globalThis.fetch });
    await expect(sb.benefits.list()).resolves.toEqual({ benefits: [] });
    expect(calls).toBe(2);
  });

  it("does not replay POSTs after a network error", async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      throw new TypeError("fetch failed");
    };
    const sb = new Spacebring({ clientId: "a", clientSecret: "b", fetch: fetch as typeof globalThis.fetch });
    await expect(sb.benefits.create({} as never)).rejects.toThrowError(TypeError);
    expect(calls).toBe(1);
  });

  it("honors an HTTP-date Retry-After header", async () => {
    // A date in the past means "retry now" — no exponential backoff wait.
    const { sb, requests } = mockClient([
      { status: 429, body: {}, headers: { "Retry-After": new Date(Date.now() - 1000).toUTCString() } },
      { status: 200, body: { benefits: [] } },
    ]);
    const started = Date.now();
    await expect(sb.benefits.list()).resolves.toEqual({ benefits: [] });
    expect(requests).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(200); // backoff would wait >= 250ms
  });

  it("aborting the per-request signal cancels a pending retry wait", async () => {
    const { sb, requests } = mockClient([{ status: 429, body: {}, headers: { "Retry-After": "60" } }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(sb.benefits.list(undefined, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(requests).toHaveLength(1); // aborted during the wait, before the retry
  });

  it("times out hung requests when timeoutMs is set", async () => {
    const fetch = (_input: unknown, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const sb = new Spacebring({
      clientId: "a",
      clientSecret: "b",
      timeoutMs: 20,
      maxRetries: 0,
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(sb.benefits.list()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("exposes the raw openapi-fetch client as an escape hatch", async () => {
    const { sb } = mockClient([{ status: 200, body: { networks: [] } }]);
    const { data, error } = await sb.raw.GET("/networks/v1", {});
    expect(error).toBeUndefined();
    expect(data).toEqual({ networks: [] });
  });
});
