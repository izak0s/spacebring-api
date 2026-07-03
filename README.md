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

TypeScript helpers are exported too: `SpacebringConfig`, `SpacebringResources`, and the raw spec types `paths` / `components` / `operations` (e.g. `components["schemas"]["invoice"]`).

---

## Authentication

HTTP Basic with your **Client ID** and **Client Secret** from **Spacebring → [Network] → Network Settings → Developers**. The client builds the `Authorization: Basic …` header for you. The API's OAuth2 flow is not currently supported.

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

---

## Escape hatch

`sb.raw` is a typed [openapi-fetch](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch) client for anything the facade doesn't expose (custom headers, response inspection):

```ts
const { data, error, response } = await sb.raw.GET("/networks/v1", {});
```

---

## Keeping up with API changes

The whole client (types + methods) is generated from Spacebring's OpenAPI spec; a nightly GitHub Action picks up spec changes and publishes a new version automatically. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
