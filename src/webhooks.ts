import type {
  RoutableWebhookEventType,
  SpacebringWebhookEvent,
  WebhookEventMap,
  WebhookEventType,
} from "./generated/webhook-events.js";

/**
 * Thrown when a webhook request fails verification. The message names the
 * failed check (missing header, stale timestamp, signature mismatch, …).
 */
export class SpacebringWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpacebringWebhookVerificationError";
  }
}

export interface SpacebringWebhooksOptions {
  /**
   * Maximum allowed age/skew of the `svix-timestamp` header in seconds,
   * in both directions. Defaults to 300 (5 minutes).
   */
  toleranceSeconds?: number;
}

/** Loosely-typed incoming headers: fetch Headers, Node's IncomingHttpHeaders, or a plain object. */
export type WebhookHeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>;

type UnroutedHandler = (payload: SpacebringWebhookEvent, type: string | undefined) => void | Promise<void>;

/**
 * Verifies and routes Spacebring webhooks (delivered via Svix, signed with
 * HMAC-SHA256). Uses the Web Crypto API only, so it runs unchanged on
 * Node.js >= 20, Cloudflare Workers, Deno, Bun, and edge runtimes.
 *
 * ```ts
 * const webhooks = new SpacebringWebhooks(process.env.SPACEBRING_WEBHOOK_SECRET!);
 * webhooks.on("booking.created", async ({ booking }) => { ... });
 * export default { fetch: (request: Request) => webhooks.handle(request) };
 * ```
 */
export class SpacebringWebhooks {
  readonly #secretBytes: Uint8Array;
  readonly #toleranceSeconds: number;
  readonly #handlers = new Map<string, Array<(payload: never) => void | Promise<void>>>();
  readonly #unrouted: UnroutedHandler[] = [];
  #key: Promise<CryptoKey> | undefined;

  /** @param secret Signing secret from the webhook endpoint settings (`whsec_...`). */
  constructor(secret: string, options?: SpacebringWebhooksOptions) {
    const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
    this.#secretBytes = base64ToBytes(encoded);
    this.#toleranceSeconds = options?.toleranceSeconds ?? 300;
  }

  /**
   * Registers a handler for an event whose payload carries a `type` field.
   * (`subscription.*` and `visitors.*` payloads don't — route those to a
   * dedicated endpoint and use {@link verifyAs}.)
   */
  on<K extends RoutableWebhookEventType>(
    type: K,
    handler: (payload: WebhookEventMap[K]) => void | Promise<void>,
  ): this {
    const handlers = this.#handlers.get(type) ?? [];
    handlers.push(handler as (payload: never) => void | Promise<void>);
    this.#handlers.set(type, handlers);
    return this;
  }

  /** Registers a fallback for verified events no on() handler matched. */
  onUnrouted(handler: UnroutedHandler): this {
    this.#unrouted.push(handler);
    return this;
  }

  /**
   * Verifies a webhook request and returns its parsed payload.
   * Reads the request body — pass a clone if you need the body elsewhere.
   */
  async verify(request: Request): Promise<SpacebringWebhookEvent>;
  /** Verifies a raw payload (the UNPARSED request body string) plus its `svix-*` headers. */
  async verify(payload: string, headers: WebhookHeadersLike): Promise<SpacebringWebhookEvent>;
  async verify(input: Request | string, headers?: WebhookHeadersLike): Promise<SpacebringWebhookEvent> {
    const [body, headerGet] =
      typeof input === "string"
        ? [input, headerLookup(headers ?? {})]
        : [await input.text(), headerLookup(input.headers)];

    const id = headerGet("svix-id");
    const timestamp = headerGet("svix-timestamp");
    const signatures = headerGet("svix-signature");
    if (!id || !timestamp || !signatures) {
      throw new SpacebringWebhookVerificationError("Missing svix-id, svix-timestamp, or svix-signature header");
    }

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      throw new SpacebringWebhookVerificationError("Invalid svix-timestamp header");
    }
    if (Math.abs(Date.now() / 1000 - timestampSeconds) > this.#toleranceSeconds) {
      throw new SpacebringWebhookVerificationError("Webhook timestamp outside the allowed tolerance");
    }

    const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
    const key = await this.#hmacKey();
    let matched = false;
    for (const part of signatures.split(" ")) {
      const [version, signature] = part.split(",", 2);
      if (version !== "v1" || !signature) continue;
      let signatureBytes: Uint8Array;
      try {
        signatureBytes = base64ToBytes(signature);
      } catch {
        continue;
      }
      // subtle.verify performs a constant-time comparison.
      if (await crypto.subtle.verify("HMAC", key, signatureBytes as BufferSource, data)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new SpacebringWebhookVerificationError("No signature matched the payload");
    }

    try {
      return JSON.parse(body) as SpacebringWebhookEvent;
    } catch {
      throw new SpacebringWebhookVerificationError("Verified payload is not valid JSON");
    }
  }

  /**
   * Verifies and returns the payload typed as a specific event — for endpoints
   * subscribed to a single event type (the only way to consume events whose
   * payload has no `type` field). Throws if the payload self-describes as a
   * different event.
   */
  async verifyAs<K extends WebhookEventType>(type: K, request: Request): Promise<WebhookEventMap[K]>;
  async verifyAs<K extends WebhookEventType>(
    type: K,
    payload: string,
    headers: WebhookHeadersLike,
  ): Promise<WebhookEventMap[K]>;
  async verifyAs<K extends WebhookEventType>(
    type: K,
    input: Request | string,
    headers?: WebhookHeadersLike,
  ): Promise<WebhookEventMap[K]> {
    const payload = await (typeof input === "string" ? this.verify(input, headers ?? {}) : this.verify(input));
    const selfDescribed = (payload as { type?: string }).type;
    if (selfDescribed !== undefined && selfDescribed !== type) {
      throw new SpacebringWebhookVerificationError(
        `Expected a ${type} event but the payload says ${selfDescribed}`,
      );
    }
    return payload as WebhookEventMap[K];
  }

  /**
   * Runs the registered handlers for an already-verified payload.
   * Events without a matching on() handler go to onUnrouted() handlers.
   */
  async dispatch(payload: SpacebringWebhookEvent): Promise<void> {
    const type = (payload as { type?: string }).type;
    const handlers = type !== undefined ? this.#handlers.get(type) : undefined;
    if (handlers && handlers.length > 0) {
      for (const handler of handlers) await handler(payload as never);
      return;
    }
    for (const handler of this.#unrouted) await handler(payload, type);
  }

  /**
   * Complete endpoint handler: verifies, dispatches, and answers.
   * 204 on success, 400 on failed verification, 500 when a handler throws
   * (so the delivery is retried).
   */
  async handle(request: Request): Promise<Response> {
    let payload: SpacebringWebhookEvent;
    try {
      payload = await this.verify(request);
    } catch (error) {
      const message = error instanceof SpacebringWebhookVerificationError ? error.message : "Verification failed";
      return new Response(message, { status: 400 });
    }
    try {
      await this.dispatch(payload);
    } catch {
      return new Response("Webhook handler failed", { status: 500 });
    }
    return new Response(null, { status: 204 });
  }

  #hmacKey(): Promise<CryptoKey> {
    this.#key ??= crypto.subtle.importKey(
      "raw",
      this.#secretBytes as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return this.#key;
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function headerLookup(headers: WebhookHeadersLike): (name: string) => string | undefined {
  if (headers instanceof Headers) {
    return (name) => headers.get(name) ?? undefined;
  }
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined) normalized.set(key.toLowerCase(), single);
  }
  return (name) => normalized.get(name);
}
