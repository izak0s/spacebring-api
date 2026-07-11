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
- **Readable, named types** — entities (`Booking`, `Invoice`) and query parameters (`GetBookingsQuery`) are exported named types, so hovers show `Booking[]` instead of generated type soup, and enum filters are literal unions
- **Rich error handling** — non-2xx responses throw a typed `SpacebringError` carrying the status, parsed body, and the operation that failed; malformed 2xx bodies and stuck pagination tokens throw instead of failing silently
- **Resilient by default** — automatic retries for rate limits, gateway errors, and network failures (never replaying non-idempotent requests); optional per-attempt timeouts and `AbortSignal` cancellation on every method
- **Zero runtime dependencies** — Node ≥ 20, `fetch`-based; type declarations are fully self-contained (TypeScript ≥ 5.4)
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
import { Spacebring, SpacebringError } from "@izak0s/spacebring-api";

const sb = new Spacebring({
  clientId: process.env.SPACEBRING_CLIENT_ID!,
  clientSecret: process.env.SPACEBRING_CLIENT_SECRET!,
  networkId: process.env.SPACEBRING_NETWORK_ID, // optional — sent as the spacebring-network-id header
});

// Single-property envelopes are unwrapped — list() gives you Location[] directly.
const locations = await sb.locations.list();
const locationRef = locations[0].id;

// Paginated lists return the page envelope, so nextPageToken stays available…
const { benefits, nextPageToken } = await sb.benefits.list({ locationRef });

// …or hand it to iterate(), which follows nextPageToken across pages.
// Break out early and it simply stops fetching — no wasted requests.
for await (const booking of sb.resources.bookings.iterate({ locationRef })) {
  console.log(`${booking.startDate} → ${booking.endDate}`);
}

// Non-2xx responses throw a typed SpacebringError.
try {
  await sb.billing.invoices.get("does-not-exist");
} catch (error) {
  if (error instanceof SpacebringError) {
    console.error(`${error.status} on ${error.operation}: ${error.body?.message}`);
  }
}
```

Writes read the same, and endpoints that return more than one payload keep the envelope intact:

```ts
const { invoice, payment } = await sb.billing.invoices.pay(invoiceId, {
  paymentMethod: { type: "stripe" },
});
```

Entity types are exported by name — `import type { Booking, Invoice, Membership } from "@izak0s/spacebring-api"` — matching what the methods return (`get`/`create`/`update` resolve to the entity, `iterate()` yields it). Query parameters get named interfaces too (`GetBookingsQuery`, `GetInvoicesQuery`), with per-field docs from the spec and enum filters as literal unions. Lower-level helpers too: `SpacebringConfig`, `SpacebringResources`, and the raw spec types `paths` / `components` / `operations`.

### Data formats

Values are passed through exactly as the API sends them — no runtime conversion:

- **Dates** (`createDate`, `startDate`, …) are ISO 8601 strings — wrap in `new Date(booking.startDate)` when you need a `Date`.
- **Money** (`amount`, `price`, …) arrives as decimal floats. Fine for display; for accounting arithmetic convert to integer cents first to avoid floating-point drift.
- **IDs** (`id`, `*Ref`) are UUID strings.

---

## Authentication

HTTP Basic with your **Client ID** and **Client Secret** from **Spacebring → [Network] → Network Settings → Developers**. The client builds the `Authorization: Basic …` header for you. The API's OAuth2 flow is not currently supported.

Because those credentials ride on every request, the client rejects a non-`https` `baseUrl` at construction — `http` is allowed only for loopback hosts (local proxies or mock servers). The default `baseUrl` is `https://api.spacebring.com`.

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
    console.error(error.operation); // "GET /benefits/v1/{benefitId}"
    console.error(error.url);       // the full request URL
  }
}
```

Malformed successes are covered too: a 2xx with an empty or incomplete body throws a `SpacebringError` (never a bare `TypeError`), and `iterate()` throws instead of looping forever if the API repeats a page token.

### Rate limits & retries

The API allows **10 requests per second**. Rate-limited requests (429) are retried automatically — up to 3 times, honoring `Retry-After` (seconds or HTTP-date) or backing off exponentially — so `iterate()` survives the limit out of the box. Gateway errors (502/503/504), network failures, and timeouts are retried the same way, but only for idempotent methods (`GET`/`PUT`/`DELETE`) — a `POST` is never replayed, since the request may have reached the API. Tune or disable via `maxRetries` in the config (`maxRetries: 0` turns it off); an error that persists past the retries is thrown as-is.

### Timeouts & cancellation

Every method accepts a trailing options argument with an `AbortSignal`; aborting cancels the in-flight request and any pending retry wait. A client-wide per-attempt timeout is available via `timeoutMs`:

```ts
const sb = new Spacebring({ clientId, clientSecret, timeoutMs: 15_000 });

const controller = new AbortController();
const benefits = await sb.benefits.list({ locationRef }, { signal: controller.signal });
```

`timeoutMs` uses `AbortSignal.timeout`; combining it with your own signal relies on `AbortSignal.any` (Node ≥ 20.3, all modern browsers/workers/edge runtimes).

---

## Escape hatch

`sb.raw` is a typed [openapi-fetch](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch) client for anything the facade doesn't expose (custom headers, response inspection):

```ts
const { data, error, response } = await sb.raw.GET("/networks/v1", {});
```

---

## Keeping up with API changes

The whole client (types + methods) is generated from Spacebring's OpenAPI spec; a daily GitHub Action picks up spec changes and publishes a new version automatically. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
