/**
 * A small, read-only tour of the client — safe to run against a live network:
 *
 *   SPACEBRING_CLIENT_ID=... SPACEBRING_CLIENT_SECRET=... npm run example
 *
 * Credentials come from Spacebring → [Network] → Network Settings → Developers.
 */
import { type Booking, Spacebring, SpacebringError } from "../src/index.js";

const { SPACEBRING_CLIENT_ID, SPACEBRING_CLIENT_SECRET, SPACEBRING_NETWORK_ID } = process.env;

if (!SPACEBRING_CLIENT_ID || !SPACEBRING_CLIENT_SECRET) {
  console.error("Set SPACEBRING_CLIENT_ID and SPACEBRING_CLIENT_SECRET to run this example.");
  process.exit(1);
}

const sb = new Spacebring({
  clientId: SPACEBRING_CLIENT_ID,
  clientSecret: SPACEBRING_CLIENT_SECRET,
  networkId: SPACEBRING_NETWORK_ID, // optional
});

// Wrapped in main() rather than top-level await so the file runs unchanged
// under both ESM and CommonJS.
async function main(): Promise<void> {
  // Single-property envelopes are unwrapped — list() hands back Location[] directly.
  const locations = await sb.locations.list();
  console.log(`Network has ${locations.length} location(s):`);
  for (const location of locations) {
    console.log(`  • ${location.title} (${location.id})`);
  }

  const location = locations[0];
  if (!location) {
    console.log("\nNo locations to explore — done.");
    return;
  }

  // Auto-pagination: iterate() follows nextPageToken across pages; breaking
  // early stops fetching. Entities come back as named types (Booking here).
  console.log(`\nUpcoming bookings in "${location.title}":`);
  const upcoming: Booking[] = [];
  for await (const booking of sb.resources.bookings.iterate({ locationRef: location.id })) {
    upcoming.push(booking);
    console.log(`  • ${booking.startDate} → ${booking.endDate}  (${booking.id})`);
    if (upcoming.length >= 10) break;
  }
  if (upcoming.length === 0) console.log("  (none)");

  // Non-2xx responses throw a typed SpacebringError carrying status, body,
  // the failing operation, and the URL.
  try {
    await sb.benefits.get("00000000-0000-0000-0000-000000000000");
  } catch (error) {
    if (!(error instanceof SpacebringError)) throw error;
    console.log(`\nExpected failure — ${error.status} on ${error.operation}: ${error.body?.message ?? error.message}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
