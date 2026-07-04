/**
 * Webhook receiver example. Starts a plain Node HTTP server, verifies incoming
 * Spacebring webhooks, and routes them to typed handlers.
 *
 *   SPACEBRING_WEBHOOK_SECRET=whsec_... npm run example:webhooks
 *
 * Without a secret it runs in demo mode: it generates one, then signs and
 * delivers a sample `booking.created` event to itself so you can see the full
 * verify -> dispatch flow end to end.
 *
 * On Cloudflare Workers or other fetch-style runtimes the same router is a
 * one-liner instead of the Node server below:
 *
 *   export default { fetch: (request: Request) => webhooks.handle(request) };
 */
import { createServer } from "node:http";
import { SpacebringWebhooks, SpacebringWebhookVerificationError } from "../src/index.js";

const demoMode = !process.env.SPACEBRING_WEBHOOK_SECRET;
const secret = process.env.SPACEBRING_WEBHOOK_SECRET ?? `whsec_${Buffer.from("demo-secret-demo-secret!").toString("base64")}`;
const port = Number(process.env.PORT ?? 8787);

const webhooks = new SpacebringWebhooks(secret);

// Typed handlers: payload shape comes from the generated event catalog types.
webhooks.on("booking.created", async ({ booking }) => {
  console.log(`Booking created: ${booking?.id} (${booking?.startDate} -> ${booking?.endDate})`);
});

webhooks.on("membership.created", async ({ membership }) => {
  console.log(`New member: ${membership?.user?.name ?? membership?.id}`);
});

webhooks.onUnrouted(async (_payload, type) => {
  console.log(`Received a verified but unhandled event: ${type ?? "(no type field)"}`);
});


const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const rawBody = Buffer.concat(chunks).toString("utf8"); // raw string — never re-serialize parsed JSON

  try {
    const event = await webhooks.verify(rawBody, req.headers);
    await webhooks.dispatch(event);
    res.writeHead(204).end();
  } catch (error) {
    if (error instanceof SpacebringWebhookVerificationError) {
      console.warn(`Rejected delivery: ${error.message}`);
      res.writeHead(400).end(error.message);
    } else {
      console.error("Handler failed:", error);
      res.writeHead(500).end(); // non-2xx makes Svix retry the delivery
    }
  }
});

server.listen(port, async () => {
  console.log(`Listening for Spacebring webhooks on http://localhost:${port}`);

  if (demoMode) {
    console.log("\nNo SPACEBRING_WEBHOOK_SECRET set — demo mode, sending a signed sample event to ourselves...\n");
    const { createHmac } = await import("node:crypto");
    const payload = JSON.stringify({
      type: "booking.created",
      booking: { id: "bk_demo", startDate: "2026-07-04T09:00:00.000Z", endDate: "2026-07-04T10:00:00.000Z" },
    });
    const id = "msg_demo";
    const timestamp = Math.floor(Date.now() / 1000);
    const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");
    const signature = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${payload}`).digest("base64");

    const response = await fetch(`http://localhost:${port}`, {
      method: "POST",
      body: payload,
      headers: { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}` },
    });
    console.log(`\nDelivery answered with HTTP ${response.status}`);

    const tampered = await fetch(`http://localhost:${port}`, {
      method: "POST",
      body: payload.replace("bk_demo", "bk_evil"),
      headers: { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}` },
    });
    console.log(`Tampered delivery answered with HTTP ${tampered.status} (rejected, as it should be)`);
    server.close();
  }
});
