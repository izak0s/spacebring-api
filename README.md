# spacebring-api

[![CI](https://github.com/izak0s/spacebring-api/actions/workflows/ci.yml/badge.svg)](https://github.com/izak0s/spacebring-api/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40izak0s%2Fspacebring-api)](https://www.npmjs.com/package/@izak0s/spacebring-api)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A fully-typed TypeScript client for the [Spacebring](https://www.spacebring.com) coworking space management API, auto-generated from the official OpenAPI spec.

> **Community package** — This is not an official Spacebring package. It is independently developed and maintained by the community. Use at your own risk. For the official API documentation, see [spacebring.com/docs/api](https://www.spacebring.com/docs/api).

---

## Features

- **<!-- coverage -->162 operations across 20 resource groups<!-- /coverage -->** — the full Spacebring API surface
- **Auto-generated** from the official OpenAPI spec — types and facade regenerate anytime the spec changes
- **Nested, discoverable API** — `sb.billing.invoices.pay(id)`, `sb.visitors.visits.checkIn(body)`
- **Auto-pagination** — every paginated list endpoint has an `iterate()` async generator that walks `nextPageToken` for you
- **Ergonomic returns** — single-property response envelopes are unwrapped: entities and plain arrays come back directly
- **Rich error handling** — non-2xx responses throw a typed `SpacebringError`; malformed 2xx bodies and stuck pagination tokens throw instead of failing silently
- **Zero runtime dependencies** — Node ≥ 20, `fetch`-based
- **Dual module** — ships both ESM and CommonJS builds with type declarations for each

---

## Installation

```sh
npm install @izak0s/spacebring-api
```

No runtime dependencies — HTTP uses the built-in `fetch`.

---

## Quick Start

```ts
import { Spacebring } from "@izak0s/spacebring-api";

const sb = new Spacebring({
  clientId: process.env.SPACEBRING_CLIENT_ID!,
  clientSecret: process.env.SPACEBRING_CLIENT_SECRET!,
  networkId: "your-network-id", // optional, sent as spacebring-network-id header
  // baseUrl: "https://api.spacebring.com",  // default
  // fetch: customFetch,                     // inject your own fetch (tests, proxies)
});

async function main() {
  // Single-property envelopes are unwrapped: entities and plain arrays come back directly
  const invoice = await sb.billing.invoices.get(invoiceId);
  const locations = await sb.locations.list();
  await sb.visitors.visits.checkIn({ locationRef, visitRef });

  // Paginated lists return the page envelope, so nextPageToken stays available
  const { benefits, nextPageToken } = await sb.benefits.list({ locationRef });

  // ...or let iterate() walk nextPageToken for you; breaking early stops fetching
  for await (const booking of sb.resources.bookings.iterate({ locationRef })) {
    console.log(booking.id);
  }

  // Endpoints returning multiple payloads keep the envelope
  const { invoice: paid, payment } = await sb.billing.invoices.pay(invoiceId, {
    paymentMethod: { type: "stripe" },
  });
}

main().catch(console.error);
```

Entity types are exported by name — `import type { Booking, Invoice, Membership } from "@izak0s/spacebring-api"` — matching what the methods return (`get`/`create`/`update` resolve to the entity, `iterate()` yields it). Lower-level helpers too: `SpacebringConfig`, `SpacebringResources`, and the raw spec types `paths` / `components` / `operations`.

### Data formats

Values are passed through exactly as the API sends them — no runtime conversion:

- **Dates** (`createDate`, `startDate`, …) are ISO 8601 strings — wrap in `new Date(booking.startDate)` when you need a `Date`.
- **Money** (`amount`, `price`, …) arrives as decimal floats. Fine for display; for accounting arithmetic convert to integer cents first to avoid floating-point drift.
- **IDs** (`id`, `*Ref`) are UUID strings.

---

## Authentication

HTTP Basic with your **Client ID** and **Client Secret** from **Spacebring → [Network] → Network Settings → Developers**. The client builds the `Authorization: Basic …` header for you. The API's OAuth2 flow is not currently supported.

For development without touching live data, Spacebring offers a [test environment](https://www.spacebring.com/docs/administration/test-environment) (Network settings → Billing add-on) with free sandbox API credentials that work with this client unchanged.

---

## Error handling

Non-2xx responses throw `SpacebringError`:

```ts
import { SpacebringError } from "@izak0s/spacebring-api";

try {
  await sb.benefits.get(id);
} catch (error) {
  if (error instanceof SpacebringError) {
    console.error(error.status, error.body?.message);
  }
}
```

Malformed successes are covered too: a 2xx with an empty or incomplete body throws a `SpacebringError` (never a bare `TypeError`), and `iterate()` throws instead of looping forever if the API repeats a page token.

### Rate limits

The API allows **10 requests per second**. Rate-limited requests (429) are retried automatically — up to 3 times, honoring `Retry-After` or backing off exponentially — so `iterate()` survives the limit out of the box. Tune or disable via `maxRetries` in the config (`maxRetries: 0` turns it off); a 429 that persists past the retries is thrown as a normal `SpacebringError`.

---

## Escape hatch

`sb.raw` is a typed [openapi-fetch](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch) client for anything the facade doesn't expose (custom headers, response inspection):

```ts
const { data, error, response } = await sb.raw.GET("/networks/v1", {});
```

---

## Webhooks

Verify and route [Spacebring webhooks](https://www.spacebring.com/docs/webhooks) on Node.js ≥ 20, Cloudflare Workers, Deno, Bun, or any edge runtime — verification uses the Web Crypto API only. The signing secret (`whsec_…`) comes from the webhook endpoint settings in Spacebring.

```ts
import { SpacebringWebhooks } from "@izak0s/spacebring-api";

const webhooks = new SpacebringWebhooks(process.env.SPACEBRING_WEBHOOK_SECRET!);

webhooks.on("booking.created", async ({ booking }) => {
  console.log("New booking", booking?.id);
});
webhooks.onUnrouted(async (payload, type) => {
  console.log("Unhandled event", type);
});

// Cloudflare Workers / fetch-style runtimes — verifies, dispatches, responds:
export default {
  fetch: (request: Request) => webhooks.handle(request),
};

// Node servers (Express etc.): verify with the RAW body string, then dispatch
const event = await webhooks.verify(rawBody, req.headers);
await webhooks.dispatch(event);
```

`handle()` answers `204` on success, `400` on failed verification, and `500` when a handler throws (so Svix retries the delivery). Handler payloads are fully typed per event (generated from the [event catalog](https://webhooks.spacebring.com/)).

One API quirk: `subscription.*` and `visitors.*` payloads carry no `type` field, so they can't be routed by `on()` — TypeScript won't let you register them. Point a dedicated endpoint at those events in Spacebring and use `verifyAs` instead:

```ts
const subscription = await webhooks.verifyAs("subscription.purchased", request);
```

---

## Keeping up with API changes

The whole client (types + methods) is generated from Spacebring's OpenAPI spec; a nightly GitHub Action picks up spec changes and publishes a new version automatically. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
