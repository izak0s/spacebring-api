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
   * How many times to retry a failed request. Retried: 429 rate limits
   * (any method — the API allows 10 requests/second and did not process the
   * request), plus 502/503/504 responses, network errors, and timeouts on
   * idempotent methods only (GET/HEAD/PUT/DELETE/OPTIONS — a gateway error
   * may have reached the API, so POSTs are never replayed). Waits per the
   * `Retry-After` header (seconds or HTTP-date), or with exponential backoff
   * when absent. Defaults to 3; 0 disables.
   */
  maxRetries?: number;
  /**
   * Timeout per request attempt in milliseconds (each retry attempt gets a
   * fresh budget). Timed-out attempts reject with a `TimeoutError` and are
   * retried like network errors. Off by default. Uses `AbortSignal.timeout`;
   * combining with a caller-supplied signal needs `AbortSignal.any`
   * (Node >= 20.3, all modern browsers/workers).
   */
  timeoutMs?: number;
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
      fetch: withRetry(config.fetch ?? globalThis.fetch, config.maxRetries ?? 3, config.timeoutMs),
    });
    Object.assign(this, createResources(this.raw, { networkId: config.networkId }));
  }
}

// A gateway error or dropped connection may have reached the API, so only
// methods that are safe to replay retry on those; 429 means the request was
// not processed and is retried regardless of method.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Adds retry (429 always; 502/503/504, network errors, and timeouts for
 * idempotent methods) and an optional per-attempt timeout. The request is
 * cloned per attempt so bodies can be resent.
 */
function withRetry(
  fetchImpl: typeof globalThis.fetch,
  maxRetries: number,
  timeoutMs: number | undefined,
): typeof globalThis.fetch {
  if (maxRetries <= 0 && timeoutMs === undefined) return fetchImpl;
  return async (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const idempotent = IDEMPOTENT_METHODS.has(request.method);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(request.clone(), attemptInit(request, timeoutMs));
      } catch (error) {
        const retryable =
          attempt < maxRetries && idempotent && !request.signal.aborted && isTransientError(error);
        if (!retryable) throw error;
        await sleep(backoffMs(attempt), request.signal);
        continue;
      }
      const retryableStatus =
        response.status === 429 || (idempotent && RETRYABLE_STATUSES.has(response.status));
      if (!retryableStatus || attempt >= maxRetries) return response;
      await sleep(retryDelayMs(response.headers.get("retry-after"), attempt), request.signal);
    }
  };
}

/** Per-attempt timeout signal, combined with the caller's signal when possible. */
function attemptInit(request: Request, timeoutMs: number | undefined): RequestInit | undefined {
  if (timeoutMs === undefined) return undefined;
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: typeof AbortSignal.any === "function" ? AbortSignal.any([request.signal, timeout]) : timeout,
  };
}

/** Network failures reject with TypeError, `AbortSignal.timeout` with TimeoutError. */
function isTransientError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    // Cap server-supplied delays: a misbehaving proxy must not be able to
    // park the client on a multi-hour setTimeout.
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter); // HTTP-date form, e.g. "Wed, 21 Oct 2026 07:28:00 GMT"
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  }
  return backoffMs(attempt);
}

function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt + Math.random() * 100, 5_000);
}

/** Waits `ms`, rejecting immediately with the abort reason if `signal` fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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