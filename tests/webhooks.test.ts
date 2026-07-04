import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WebhookEventMap } from "../src/index.js";
import { SpacebringWebhooks, SpacebringWebhookVerificationError } from "../src/index.js";

const SECRET_BYTES = randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

function sign(id: string, timestamp: number, payload: string, secretBytes: Buffer = SECRET_BYTES): string {
  const digest = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return `v1,${digest}`;
}

function signedHeaders(payload: string, overrides?: Partial<Record<"id" | "timestamp" | "signature", string>>) {
  const id = overrides?.id ?? "msg_1";
  const timestamp = overrides?.timestamp ?? String(Math.floor(Date.now() / 1000));
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": overrides?.signature ?? sign(id, Number(timestamp), payload),
  };
}

const bookingPayload = JSON.stringify({ type: "booking.created", booking: { id: "bk_1" } });

describe("SpacebringWebhooks.verify", () => {
  it("accepts a correctly signed payload (raw body + headers)", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    const event = await webhooks.verify(bookingPayload, signedHeaders(bookingPayload));
    expect(event).toMatchObject({ type: "booking.created", booking: { id: "bk_1" } });
  });

  it("accepts a fetch-API Request", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body: bookingPayload,
      headers: signedHeaders(bookingPayload),
    });
    const event = await webhooks.verify(request);
    expect(event).toMatchObject({ type: "booking.created" });
  });

  it("accepts when one of several space-delimited signatures matches", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    const headers = signedHeaders(bookingPayload);
    headers["svix-signature"] = `v1,${randomBytes(32).toString("base64")} ${headers["svix-signature"]}`;
    await expect(webhooks.verify(bookingPayload, headers)).resolves.toBeTruthy();
  });

  it("rejects a tampered body", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    const headers = signedHeaders(bookingPayload);
    const tampered = bookingPayload.replace("bk_1", "bk_2");
    await expect(webhooks.verify(tampered, headers)).rejects.toBeInstanceOf(SpacebringWebhookVerificationError);
  });

  it("rejects a signature from the wrong secret", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    const headers = signedHeaders(bookingPayload, {
      signature: sign("msg_1", Math.floor(Date.now() / 1000), bookingPayload, randomBytes(24)),
    });
    await expect(webhooks.verify(bookingPayload, headers)).rejects.toThrowError("No signature matched");
  });

  it("rejects timestamps outside the tolerance, both directions", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    for (const skew of [-301, 301]) {
      const timestamp = String(Math.floor(Date.now() / 1000) + skew);
      const headers = signedHeaders(bookingPayload, { timestamp });
      await expect(webhooks.verify(bookingPayload, headers)).rejects.toThrowError("tolerance");
    }
  });

  it("respects a custom tolerance", async () => {
    const webhooks = new SpacebringWebhooks(SECRET, { toleranceSeconds: 1000 });
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const headers = signedHeaders(bookingPayload, { timestamp });
    await expect(webhooks.verify(bookingPayload, headers)).resolves.toBeTruthy();
  });

  it("rejects missing headers", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    await expect(webhooks.verify(bookingPayload, {})).rejects.toThrowError("Missing svix-");
  });
});

describe("SpacebringWebhooks routing", () => {
  it("dispatches to the typed handler and answers 204", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    const seen: string[] = [];
    webhooks.on("booking.created", (payload) => {
      seen.push(payload.booking?.id ?? "?");
    });
    const response = await webhooks.handle(
      new Request("https://example.com/webhook", {
        method: "POST",
        body: bookingPayload,
        headers: signedHeaders(bookingPayload),
      }),
    );
    expect(response.status).toBe(204);
    expect(seen).toEqual(["bk_1"]);
  });

  it("sends unmatched events to onUnrouted", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    const unrouted: Array<string | undefined> = [];
    webhooks.on("booking.created", () => {
      throw new Error("wrong handler");
    });
    webhooks.onUnrouted((_payload, type) => {
      unrouted.push(type);
    });
    const payload = JSON.stringify({ type: "company.created", company: { id: "c_1" } });
    await webhooks.dispatch(await webhooks.verify(payload, signedHeaders(payload)));
    const typeless = JSON.stringify({ id: "sub_1", period: "month" });
    await webhooks.dispatch(await webhooks.verify(typeless, signedHeaders(typeless)));
    expect(unrouted).toEqual(["company.created", undefined]);
  });

  it("answers 400 on verification failure and 500 on handler failure", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    webhooks.on("booking.created", () => {
      throw new Error("boom");
    });
    const bad = await webhooks.handle(
      new Request("https://example.com/webhook", { method: "POST", body: bookingPayload }),
    );
    expect(bad.status).toBe(400);
    const failing = await webhooks.handle(
      new Request("https://example.com/webhook", {
        method: "POST",
        body: bookingPayload,
        headers: signedHeaders(bookingPayload),
      }),
    );
    expect(failing.status).toBe(500);
  });

  it("verifyAs types the payload and rejects self-described mismatches", async () => {
    const webhooks = new SpacebringWebhooks(SECRET);
    const subscription = JSON.stringify({ id: "sub_1", period: "month" });
    const typed = await webhooks.verifyAs("subscription.purchased", subscription, signedHeaders(subscription));
    expect(typed.id).toBe("sub_1");
    await expect(
      webhooks.verifyAs("subscription.purchased", bookingPayload, signedHeaders(bookingPayload)),
    ).rejects.toThrowError("Expected a subscription.purchased");
  });
});

describe("webhook event catalog", () => {
  it("generated map covers exactly the vendored catalog", () => {
    const catalog = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "webhook-events.json"), "utf8"),
    ) as Array<{ name: string }>;
    const generated = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "generated", "webhook-events.ts"),
      "utf8",
    );
    for (const { name } of catalog) {
      expect(generated, `missing event ${name}`).toContain(`"${name}":`);
    }
    // Type-level: a known event maps to its payload type.
    const check: WebhookEventMap["booking.created"]["type"] = "booking.created";
    expect(check).toBe("booking.created");
  });
});
