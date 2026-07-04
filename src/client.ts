import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./generated/schema.js";
import { createResources, type SpacebringResources } from "./generated/resources/index.js";

export interface SpacebringConfig {
  /** Client ID from Spacebring > Network Settings > Developers. */
  clientId: string;
  /** Client secret from Spacebring > Network Settings > Developers. */
  clientSecret: string;
  /** Network ID, sent as the `spacebring-network-id` header on every request. */
  networkId?: string;
  /** API origin. Defaults to `https://api.spacebring.com`. */
  baseUrl?: string;
  /** Custom fetch implementation (testing, non-standard platforms). */
  fetch?: typeof globalThis.fetch;
  /**
   * How many times to retry a request the API rate-limited with a 429
   * (the API allows 10 requests/second). Waits per the `Retry-After` header,
   * or with exponential backoff when absent. Defaults to 3; 0 disables.
   */
  maxRetries?: number;
}

export interface Spacebring extends SpacebringResources {}

export class Spacebring {
  /** Typed openapi-fetch client — escape hatch for endpoints or options the facade does not cover. */
  readonly raw: Client<paths>;

  constructor(config: SpacebringConfig) {
    const headers: Record<string, string> = {
      Authorization: `Basic ${toBase64(`${config.clientId}:${config.clientSecret}`)}`,
    };
    if (config.networkId) {
      headers["spacebring-network-id"] = config.networkId;
    }
    this.raw = createClient<paths>({
      baseUrl: config.baseUrl ?? "https://api.spacebring.com",
      headers,
      fetch: withRetry(config.fetch ?? globalThis.fetch, config.maxRetries ?? 3),
    });
    Object.assign(this, createResources(this.raw, { networkId: config.networkId }));
  }
}

/**
 * Retries 429 responses. The request is cloned per attempt so bodies can be
 * resent; 429 means the API did not process the request, so any method is
 * safe to retry.
 */
function withRetry(fetchImpl: typeof globalThis.fetch, maxRetries: number): typeof globalThis.fetch {
  if (maxRetries <= 0) return fetchImpl;
  return async (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(request.clone());
      if (response.status !== 429 || attempt >= maxRetries) return response;
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter * 1000
          : Math.min(250 * 2 ** attempt + Math.random() * 100, 5_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  };
}

function toBase64(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
