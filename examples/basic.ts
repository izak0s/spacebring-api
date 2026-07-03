/**
 * Basic usage example. Only performs read-only calls, so it is safe to run
 * against a live network:
 *
 *   SPACEBRING_CLIENT_ID=... SPACEBRING_CLIENT_SECRET=... npm run example
 *
 * Credentials come from Spacebring > [Network] > Network Settings > Developers.
 */
import { Spacebring, SpacebringError } from "../src/index.js";

const clientId = process.env.SPACEBRING_CLIENT_ID;
const clientSecret = process.env.SPACEBRING_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set SPACEBRING_CLIENT_ID and SPACEBRING_CLIENT_SECRET environment variables.");
  process.exit(1);
}

const sb = new Spacebring({
  clientId,
  clientSecret,
  networkId: process.env.SPACEBRING_NETWORK_ID, // optional
});

// Wrapped in main() instead of top-level await so this file runs unchanged
// in both ESM and CommonJS projects.
async function main() {
  // --- Single-property envelopes are unwrapped: entities/arrays come back directly
  const locations = await sb.locations.list();
  console.log(`Network has ${locations.length} location(s):`);
  for (const location of locations) {
    console.log(`  - ${location.title} (${location.id})`);
  }

  const firstLocation = locations[0];
  if (!firstLocation) {
    console.log("No locations available; nothing more to show.");
    return;
  }

  // --- Auto-pagination: iterate() follows nextPageToken --------------------
  console.log(`\nUpcoming bookings in "${firstLocation.title}":`);
  let bookingCount = 0;
  for await (const booking of sb.resources.bookings.iterate({ locationRef: firstLocation.id })) {
    console.log(`  - ${booking.id}: ${booking.startDate} -> ${booking.endDate}`);
    bookingCount += 1;
    if (bookingCount >= 10) break; // stop early; no more pages are fetched
  }
  if (bookingCount === 0) console.log("  (none)");

  // --- Error handling: non-2xx responses throw SpacebringError -------------
  try {
    await sb.benefits.get("00000000-0000-0000-0000-000000000000");
  } catch (error) {
    if (error instanceof SpacebringError) {
      console.log(`\nExpected failure: HTTP ${error.status} — ${error.message}`);
    } else {
      throw error;
    }
  }

  // --- Escape hatch: typed openapi-fetch client -----------------------------
  const { data, response } = await sb.raw.GET("/networks/v1", {});
  console.log(`\nRaw call to /networks/v1 -> HTTP ${response.status}, ${data?.networks?.length ?? 0} network(s).`);
}

main().catch(console.error);
