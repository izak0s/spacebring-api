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
      fetch: config.fetch,
    });
    Object.assign(this, createResources(this.raw, { networkId: config.networkId }));
  }
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
