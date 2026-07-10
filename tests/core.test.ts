import { describe, expect, it } from "vitest";
import { paginate, unwrap, unwrapProp } from "../src/core.js";
import { SpacebringError } from "../src/error.js";

function response(status: number): Response {
  return new Response(status === 204 ? null : "{}", { status });
}

describe("unwrap", () => {
  it("returns data on success", () => {
    expect(unwrap({ data: { id: "x" }, response: response(200) })).toEqual({ id: "x" });
  });

  it("returns undefined for 204 no-content", () => {
    expect(unwrap({ data: undefined, response: response(204) })).toBeUndefined();
  });

  it("throws SpacebringError when the result carries an error", () => {
    expect(() => unwrap({ error: { message: "nope", type: "bad" }, response: response(400) })).toThrowError(SpacebringError);
    try {
      unwrap({ error: { message: "nope", type: "bad" }, response: response(400) });
      expect.unreachable();
    } catch (error) {
      const spacebringError = error as SpacebringError;
      expect(spacebringError.status).toBe(400);
      expect(spacebringError.message).toBe("nope");
      expect(spacebringError.body).toEqual({ message: "nope", type: "bad" });
    }
  });

  it("throws on non-2xx even without a parsed error body", () => {
    expect(() => unwrap({ data: undefined, response: response(500) })).toThrowError(SpacebringError);
  });
});

describe("unwrapProp", () => {
  it("returns the envelope property", () => {
    expect(unwrapProp({ data: { benefit: { id: "b1" } }, response: response(200) }, "benefit")).toEqual({ id: "b1" });
  });

  it("throws SpacebringError instead of a TypeError when a 200 body is empty", () => {
    expect(() => unwrapProp({ data: undefined, response: response(200) }, "benefit" as never)).toThrowError(SpacebringError);
    expect(() => unwrapProp<{ benefit?: object }, "benefit">({ data: {}, response: response(200) }, "benefit")).toThrowError(
      'Response is missing the "benefit" property',
    );
  });
});

describe("paginate", () => {
  const page = (items: string[], nextPageToken?: string) => ({ items, nextPageToken });

  async function collect<T>(iterator: AsyncGenerator<T, void, undefined>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iterator) out.push(item);
    return out;
  }

  it("yields items from a single page", async () => {
    const items = await collect(paginate(async () => page(["a", "b"]), "items"));
    expect(items).toEqual(["a", "b"]);
  });

  it("passes the token through and stops when it disappears", async () => {
    const tokens: Array<string | undefined> = [];
    const pages = [page(["a"], "t1"), page(["b"], "t2"), page(["c"])];
    let call = 0;
    const items = await collect(
      paginate(async (token: string | undefined) => {
        tokens.push(token);
        return pages[call++];
      }, "items"),
    );
    expect(items).toEqual(["a", "b", "c"]);
    expect(tokens).toEqual([undefined, "t1", "t2"]);
  });

  it("throws instead of looping forever when the token never advances", async () => {
    await expect(collect(paginate(async () => page(["a"], "same-token"), "items"))).rejects.toThrowError(
      "Pagination did not advance",
    );
  });

  it("tolerates pages with a missing items array", async () => {
    const items = await collect(
      paginate(async () => ({ nextPageToken: undefined }) as { items?: string[]; nextPageToken?: string }, "items"),
    );
    expect(items).toEqual([]);
  });
});

describe("SpacebringError", () => {
  it("falls back to a status message when the body is not an object", () => {
    const error = new SpacebringError(502, "bad gateway");
    expect(error.message).toBe("Spacebring API request failed with status 502");
    expect(error.body).toBeUndefined();
  });

  it("uses the API message and keeps the body", () => {
    const error = new SpacebringError(400, { message: "locationRef is required", type: "invalid" });
    expect(error.message).toBe("locationRef is required");
    expect(error.body?.type).toBe("invalid");
    expect(error.name).toBe("SpacebringError");
  });

  it("surfaces validation issues in the message", () => {
    const error = new SpacebringError(
      400,
      {
        message: "Invalid request parameters",
        type: "validationError",
        issues: [
          { code: "invalid_type", path: ["locationRef"], message: "Required" },
          { code: "custom", path: [], message: "Provide locationRef or customerRef" },
        ],
      },
      { operation: "GET /subscriptions/v1" },
    );
    expect(error.message).toBe(
      "Invalid request parameters — locationRef: Required; Provide locationRef or customerRef (GET /subscriptions/v1)",
    );
  });

  it("carries the operation and url and appends the operation to the message", () => {
    const error = new SpacebringError(404, undefined, {
      operation: "GET /benefits/v1/{benefitId}",
      url: "https://api.spacebring.com/benefits/v1/b1",
    });
    expect(error.message).toBe("Spacebring API request failed with status 404 (GET /benefits/v1/{benefitId})");
    expect(error.operation).toBe("GET /benefits/v1/{benefitId}");
    expect(error.url).toBe("https://api.spacebring.com/benefits/v1/b1");
  });
});
