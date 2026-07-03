import { describe, expect, it } from "vitest";
import { Spacebring, SpacebringError } from "../src/index.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

function mockClient(responses: Array<{ status: number; body?: unknown }>, config?: { networkId?: string }) {
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
      return new Response(null, { status: next.status });
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const sb = new Spacebring({
    clientId: "client id",
    clientSecret: "client secret",
    networkId: config?.networkId,
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

  it("throws SpacebringError with status and body on API errors", async () => {
    const { sb } = mockClient([{ status: 400, body: { message: "locationRef is required", type: "invalid_request" } }]);
    const failure = sb.benefits.list();
    await expect(failure).rejects.toBeInstanceOf(SpacebringError);
    await expect(failure).rejects.toMatchObject({
      status: 400,
      message: "locationRef is required",
      body: { type: "invalid_request" },
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

  it("exposes the raw openapi-fetch client as an escape hatch", async () => {
    const { sb } = mockClient([{ status: 200, body: { networks: [] } }]);
    const { data, error } = await sb.raw.GET("/networks/v1", {});
    expect(error).toBeUndefined();
    expect(data).toEqual({ networks: [] });
  });
});
