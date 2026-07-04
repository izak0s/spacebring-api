/**
 * Downloads the Svix-hosted webhook event catalog (https://webhooks.spacebring.com/)
 * and vendors its event types into spec/webhook-events.json.
 *
 * The catalog is a Next.js page whose __NEXT_DATA__ payload embeds every event
 * type with a JSON Schema (draft-07) and examples. This script is the only
 * networked step; generate-webhooks.ts works offline from the vendored file.
 * Fails loudly if the page structure changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG_URL = "https://webhooks.spacebring.com/";
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "webhook-events.json");

interface CatalogEventType {
  name: string;
  description: string;
  deprecated: boolean;
  schemas: Record<string, unknown> | null;
}

const response = await fetch(CATALOG_URL);
if (!response.ok) {
  console.error(`Failed to download ${CATALOG_URL}: HTTP ${response.status}`);
  process.exit(1);
}
const html = await response.text();

const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
if (!match) {
  console.error("Catalog page has no __NEXT_DATA__ script tag — page structure changed, update this script.");
  process.exit(1);
}

const eventTypes: CatalogEventType[] | undefined = JSON.parse(match[1])?.props?.pageProps?.eventTypes;
if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
  console.error("Catalog __NEXT_DATA__ has no props.pageProps.eventTypes — structure changed, update this script.");
  process.exit(1);
}

const vendored = eventTypes
  .map(({ name, description, deprecated, schemas }) => ({ name, description, deprecated, schemas }))
  .sort((a, b) => a.name.localeCompare(b.name));

const json = JSON.stringify(vendored, null, 2) + "\n";
let previous = "";
try {
  previous = readFileSync(OUT_PATH, "utf8");
} catch {
  // first run
}
if (previous !== json) writeFileSync(OUT_PATH, json);
console.log(`Vendored ${vendored.length} webhook event types${previous === json ? " (unchanged)" : ""}.`);
