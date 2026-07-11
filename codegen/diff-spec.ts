/**
 * Emits a phone-readable markdown summary of what changed between two OpenAPI
 * specs (plus, optionally, two API-surface snapshots) for the regen PR body.
 *
 *   tsx codegen/diff-spec.ts <old-spec> <new-spec> [<old-snapshot> <new-snapshot>]
 *
 * Sections:
 * - Methods: facade methods added/removed (from the surface snapshot)
 * - Operations: endpoints added/removed, and which part of an operation
 *   changed (parameters — with per-parameter +/−/~ detail — / request body /
 *   responses)
 * - Schemas: component schemas added/removed, and per-schema property-level
 *   additions/removals/changes
 *
 * Output is capped per section so the PR body stays skimmable.
 */
import { readFileSync } from "node:fs";

const MAX_LINES_PER_SECTION = 40;

const [oldSpecPath, newSpecPath, oldSnapPath, newSnapPath] = process.argv.slice(2);
if (!oldSpecPath || !newSpecPath) {
  console.error("Usage: tsx codegen/diff-spec.ts <old-spec> <new-spec> [<old-snapshot> <new-snapshot>]");
  process.exit(1);
}

interface Spec {
  paths?: Record<string, Record<string, { summary?: string; parameters?: unknown; requestBody?: unknown; responses?: unknown }>>;
  components?: { schemas?: Record<string, unknown> };
}

const oldSpec: Spec = JSON.parse(readFileSync(oldSpecPath, "utf8"));
const newSpec: Spec = JSON.parse(readFileSync(newSpecPath, "utf8"));

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function capped(lines: string[]): string[] {
  if (lines.length <= MAX_LINES_PER_SECTION) return lines;
  return [...lines.slice(0, MAX_LINES_PER_SECTION), `- …and ${lines.length - MAX_LINES_PER_SECTION} more`];
}

const sections: string[] = [];

// --- Facade methods (surface snapshot diff) --------------------------------

function snapshotMethods(path: string): Set<string> {
  const content = readFileSync(path, "utf8");
  return new Set(
    content
      .split("\n")
      // The vitest snapshot's string delimiters sit on the first/last content lines.
      .map((line) => line.trim().replace(/^"/, "").replace(/"$/, ""))
      .filter((line) => /^[a-zA-Z][\w.]*\(\)$/.test(line)),
  );
}

if (oldSnapPath && newSnapPath) {
  const before = snapshotMethods(oldSnapPath);
  const after = snapshotMethods(newSnapPath);
  const added = [...after].filter((m) => !before.has(m)).sort();
  const removed = [...before].filter((m) => !after.has(m)).sort();
  if (added.length > 0 || removed.length > 0) {
    sections.push(
      "### Methods\n" +
        capped([...removed.map((m) => `- 🔴 \`${m}\` removed`), ...added.map((m) => `- 🟢 \`${m}\` added`)]).join("\n"),
    );
  }
}

// --- Operations -------------------------------------------------------------

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

function operations(
  spec: Spec,
): Map<string, { summary?: string; parameters?: unknown; requestBody?: unknown; responses?: unknown }> {
  const map = new Map<string, { summary?: string; parameters?: unknown; requestBody?: unknown; responses?: unknown }>();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (methods[method]) map.set(`${method.toUpperCase()} ${path}`, methods[method]);
    }
  }
  return map;
}

const oldOps = operations(oldSpec);
const newOps = operations(newSpec);
const opLines: string[] = [];

/**
 * Per-parameter +/−/~ detail for a changed operation, mirroring the schema
 * section's notation. Parameters are keyed by (in, name); a parameter whose
 * definition changed in any way (schema, description, required, deprecated)
 * shows as ~. Falls back to the bare "parameters" label when an entry isn't
 * the inline named-object shape this spec uses.
 */
function parameterDetail(before: unknown, after: unknown): string {
  const toMap = (params: unknown): Map<string, { name: string; value: unknown }> | null => {
    if (params === undefined) return new Map();
    if (!Array.isArray(params)) return null;
    const map = new Map<string, { name: string; value: unknown }>();
    for (const param of params) {
      if (param === null || typeof param !== "object") return null;
      const { name, in: location } = param as { name?: unknown; in?: unknown };
      if (typeof name !== "string" || typeof location !== "string") return null;
      map.set(`${location}:${name}`, { name, value: param });
    }
    return map;
  };
  const beforeMap = toMap(before);
  const afterMap = toMap(after);
  if (!beforeMap || !afterMap) return "parameters";
  const parts: string[] = [];
  for (const [key, { name }] of afterMap) if (!beforeMap.has(key)) parts.push(`+\`${name}\``);
  for (const [key, { name }] of beforeMap) if (!afterMap.has(key)) parts.push(`−\`${name}\``);
  for (const [key, { name, value }] of afterMap) {
    if (beforeMap.has(key) && !same(beforeMap.get(key)?.value, value)) parts.push(`~\`${name}\``);
  }
  const detail = parts.length > 8 ? [...parts.slice(0, 8), `…${parts.length - 8} more`] : parts;
  return `parameters: ${detail.join(" ")}`;
}

for (const [key, op] of [...oldOps].sort(([a], [b]) => a.localeCompare(b))) {
  if (!newOps.has(key)) opLines.push(`- 🔴 \`${key}\` removed${op.summary ? ` — ${op.summary}` : ""}`);
}
for (const [key, op] of [...newOps].sort(([a], [b]) => a.localeCompare(b))) {
  const before = oldOps.get(key);
  if (!before) {
    opLines.push(`- 🟢 \`${key}\` added${op.summary ? ` — ${op.summary}` : ""}`);
  } else if (!same(before, op)) {
    const parts = [
      !same(before.parameters, op.parameters) && parameterDetail(before.parameters, op.parameters),
      !same(before.requestBody, op.requestBody) && "request body",
      !same(before.responses, op.responses) && "responses",
    ].filter(Boolean);
    opLines.push(`- 🟡 \`${key}\` changed${parts.length ? ` (${parts.join("; ")})` : ""}`);
  }
}
if (opLines.length > 0) sections.push("### Operations\n" + capped(opLines).join("\n"));

// --- Component schemas -------------------------------------------------------

/** Collects dotted paths of added/removed/changed leaves between two JSON nodes. */
function diffPaths(
  before: unknown,
  after: unknown,
  prefix: string,
  out: { added: string[]; removed: string[]; changed: string[] },
): void {
  if (same(before, after)) return;
  const bothObjects =
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after);
  if (!bothObjects) {
    out.changed.push(prefix);
    return;
  }
  // Scalar arrays (enum, required): report added/removed values, not indices —
  // "+enum: \"stripe\"" beats "+enum.4".
  const isScalar = (value: unknown) => value === null || typeof value !== "object";
  if (Array.isArray(before) && Array.isArray(after) && before.every(isScalar) && after.every(isScalar)) {
    const beforeSet = new Set(before.map((value) => JSON.stringify(value)));
    const afterSet = new Set(after.map((value) => JSON.stringify(value)));
    for (const value of beforeSet) if (!afterSet.has(value)) out.removed.push(`${prefix}: ${value}`);
    for (const value of afterSet) if (!beforeSet.has(value)) out.added.push(`${prefix}: ${value}`);
    // Same values, different order — still a change; say so instead of staying silent.
    if (beforeSet.size === afterSet.size && [...beforeSet].every((value) => afterSet.has(value))) {
      out.changed.push(`${prefix} (reordered)`);
    }
    return;
  }
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!(key in a)) out.removed.push(prefix ? `${prefix}.${key}` : key);
  }
  for (const key of Object.keys(a)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in b)) out.added.push(path);
    else diffPaths(b[key], a[key], path, out);
  }
}

const oldSchemas = oldSpec.components?.schemas ?? {};
const newSchemas = newSpec.components?.schemas ?? {};
const schemaLines: string[] = [];

for (const name of Object.keys(oldSchemas).sort()) {
  if (!(name in newSchemas)) schemaLines.push(`- 🔴 \`${name}\` removed`);
}
for (const name of Object.keys(newSchemas).sort()) {
  if (!(name in oldSchemas)) {
    schemaLines.push(`- 🟢 \`${name}\` added`);
  } else if (!same(oldSchemas[name], newSchemas[name])) {
    const out = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
    diffPaths(oldSchemas[name], newSchemas[name], "", out);
    const parts = [
      ...out.added.map((p) => `+\`${p}\``),
      ...out.removed.map((p) => `−\`${p}\``),
      ...out.changed.map((p) => `~\`${p}\``),
    ];
    const detail = parts.length > 8 ? [...parts.slice(0, 8), `…${parts.length - 8} more`] : parts;
    schemaLines.push(`- 🟡 \`${name}\`: ${detail.join(" ")}`);
  }
}
if (schemaLines.length > 0) sections.push("### Schemas\n" + capped(schemaLines).join("\n"));

// -----------------------------------------------------------------------------

if (sections.length === 0) {
  console.log("_Spec changed only in ways not covered by this summary (descriptions, metadata, or non-schema components)._");
} else {
  console.log(sections.join("\n\n"));
}
