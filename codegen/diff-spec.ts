/**
 * Emits a phone-readable markdown summary of what changed between two OpenAPI
 * specs (plus, optionally, two API-surface snapshots) for the regen PR body.
 *
 *   tsx codegen/diff-spec.ts <old-spec> <new-spec> \
 *     [<old-snapshot> <new-snapshot>] [<old-typed-surface> <new-typed-surface>] \
 *     [--max-chars=N]
 *
 * Sections:
 * - Breaking: everything in this diff a consumer can trip over, gathered from
 *   every other section into one list at the top (typed-surface removals and
 *   signature changes when the typed-surface snapshots are passed, plus
 *   wire-level breaks the TypeScript types don't encode: removed endpoints,
 *   removed properties, retyped leaves, newly required request fields)
 * - Methods: facade methods added/removed (from the surface snapshot)
 * - Operations: endpoints added/removed, and which part of an operation
 *   changed (parameters — with per-parameter +/−/~ detail — / request body /
 *   responses)
 * - Schemas: component schemas added/removed, and per-schema property-level
 *   additions/removals/changes
 * - Components: other components ($ref'd requestBodies/parameters/responses/…)
 *   added/removed/changed — catches shared-object edits an operation's $ref hides
 *
 * Nothing is elided: every changed operation, schema, component and leaf path
 * is listed. A changed member renders as a bold header line carrying its leaf
 * count, then one sub-bullet per kind listing every path — the same shape
 * whether it changed 2 leaves or 200, so colour means one thing throughout and
 * the eye never has to switch notations:
 *
 * - 🟢 added / 🔴 removed — properties that appeared or disappeared
 * - 🟠 retyped — a non-prose leaf (type, format, enum, constraint) whose value
 *   changed, rendered `before` → `after` so the PR answers "changed how?"
 *   without opening the spec. Measured over two months of syncs these are ~4%
 *   of leaf changes but carry every genuinely dangerous one (a `string` →
 *   `number` field type hid among description edits).
 * - ⚪ reordered — an array holding the same values in a new order: upstream
 *   key-shuffle noise, split out so it never reads as a real change
 * - 📝 docs reworded — prose leaves (description/summary/title), the ~90% bulk,
 *   with full before/after inside a <details> so they can't drown the rest
 *
 * `--max-chars=N` is a last-resort guard for hosts with a hard body limit
 * (GitHub PR bodies cap at 65536 characters): the summary is trimmed at a line
 * boundary and marked as trimmed, rather than the whole PR-creation call
 * failing. Unlimited when the flag is absent.
 */
import { readFileSync } from "node:fs";
import { classify, parseSurface } from "./classify-surface.js";

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith("--"));
const [oldSpecPath, newSpecPath, oldSnapPath, newSnapPath, oldTypedPath, newTypedPath] = positional;
const usage =
  "Usage: tsx codegen/diff-spec.ts <old-spec> <new-spec> [<old-snapshot> <new-snapshot>] [<old-typed-surface> <new-typed-surface>] [--max-chars=N]";
if (!oldSpecPath || !newSpecPath) {
  console.error(usage);
  process.exit(1);
}

let maxChars = Number.POSITIVE_INFINITY;
for (const flag of argv.filter((arg) => arg.startsWith("--"))) {
  const match = /^--max-chars=(\d+)$/.exec(flag);
  if (!match || Number(match[1]) === 0) {
    console.error(`Unknown or invalid flag: ${flag}\n${usage}`);
    process.exit(1);
  }
  maxChars = Number(match[1]);
}

interface Operation {
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
}

interface Spec {
  paths?: Record<string, Record<string, Operation>>;
  components?: Record<string, Record<string, unknown> | undefined>;
}

const oldSpec: Spec = JSON.parse(readFileSync(oldSpecPath, "utf8"));
const newSpec: Spec = JSON.parse(readFileSync(newSpecPath, "utf8"));

/**
 * Recursively sorts object keys (arrays keep their order) so equality ignores
 * key ordering. Without this a spec that only reshuffled an object's keys reads
 * as a change: JSON.stringify differs, yet every leaf is identical, so the
 * per-property diff comes up empty and we'd emit a phantom "🟡 changed" line
 * with no detail. Array order is preserved — it can be meaningful, and enum /
 * required reordering is reported explicitly elsewhere.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const sections: string[] = [];

/**
 * Everything a consumer can trip over, collected as the other sections are
 * built and rendered first. Deliberately broader than the auto-merge gate
 * (`classify-surface.ts`, which only sees the TypeScript surface): a removed
 * response property or a retyped field breaks callers at runtime while the
 * generated signatures stay identical.
 */
interface WireBreak {
  /** Schema, component or endpoint the break belongs to. */
  member: string;
  kind: "member" | "endpoint" | "parameter" | "removed" | "relaxed" | "retyped" | "required";
  detail: string;
}

const breaking: WireBreak[] = [];

/**
 * Breaks in the generated TypeScript itself — what stops a consumer's build.
 * Kept apart from the wire-level list because the two answer different
 * questions: "will my code still compile" vs "will my code still behave".
 */
const breakingSurface: string[] = [];

/**
 * Sunset notices: not breaking today, but the one thing in a spec diff that
 * asks a consumer to act before it becomes breaking. Gathered into their own
 * section — as plain leaves they render 🟢 green, reading as a field gained
 * rather than a field going away.
 */
const deprecations: string[] = [];

/** Prose leaves carry wording, never contract — they are never breaking. */
const PROSE_LEAVES = new Set(["description", "summary", "title", "example"]);
const isProse = (path: string): boolean => PROSE_LEAVES.has(path.split(".").pop() ?? "");

const renderValue = (v: unknown): string => `\`${JSON.stringify(v)}\``;

// --- Typed surface (compile-level breaks) ----------------------------------
// Same comparison the auto-merge gate runs, reported here as prose so the PR
// says which signature moved without a snapshot diff read. Every removed line
// is paired with its replacement where one exists: "removed" alone can't tell
// a dropped method from a parameter that merely became optional, and the two
// deserve opposite reactions.

/** What a snapshot line is *about*, so a changed line can find its replacement. */
function lineIdentity(line: string): string | null {
  const property = /^("[^"]+"|[A-Za-z_$][\w$]*)\??:/.exec(line);
  if (property) return `property ${property[1]}`;
  const method = /^(?:async )?([A-Za-z_$][\w$]*)[(<]/.exec(line);
  if (method) return `method ${method[1]}`;
  const declaration = /^export (?:type|interface) (\w+)/.exec(line);
  if (declaration) return `type ${declaration[1]}`;
  return null;
}

/** `resources.ts|interface GetAssignmentsQuery` → "resources.ts · GetAssignmentsQuery". */
function contextLabel(context: string): string {
  const [file = "", block = ""] = context.split("|");
  return block.startsWith("interface ") ? `${file} · ${block.slice("interface ".length)}` : file;
}

let relaxations = 0;

if (oldTypedPath && newTypedPath) {
  const before = parseSurface(readFileSync(oldTypedPath, "utf8"));
  const after = parseSurface(readFileSync(newTypedPath, "utf8"));
  const { reasons } = classify(before, after);

  const beforeByKey = new Map(before.entries.map((entry) => [entry.key, entry]));
  const afterByKey = new Map(after.entries.map((entry) => [entry.key, entry]));
  // Candidate replacements: lines the new snapshot has and the old one didn't,
  // indexed by the thing they describe within their own context.
  const replacements = new Map<string, string[]>();
  for (const entry of after.entries) {
    if (before.lines.has(entry.key)) continue;
    const identity = lineIdentity(entry.line);
    if (identity === null) continue;
    const key = `${entry.context}|${identity}`;
    replacements.set(key, [...(replacements.get(key) ?? []), entry.line]);
  }

  const REMOVED = "removed or changed: ";
  const REQUIRED = "required property added to existing interface: ";
  const withoutOptionals = (line: string) => line.replace(/\?/g, "");
  const optionals = (line: string) => (line.match(/\?/g) ?? []).length;

  for (const reason of reasons) {
    if (reason.startsWith(REQUIRED)) {
      const entry = afterByKey.get(reason.slice(REQUIRED.length));
      if (entry) {
        breakingSurface.push(`➕ \`${contextLabel(entry.context)}\` — new required property: \`${entry.line}\``);
      }
      continue;
    }
    const entry = beforeByKey.get(reason.slice(REMOVED.length));
    if (!entry) continue;
    const identity = lineIdentity(entry.line);
    const replacement = identity === null ? undefined : replacements.get(`${entry.context}|${identity}`)?.[0];
    const name = identity?.replace(/^\w+ /, "") ?? "";
    const at = `\`${contextLabel(entry.context)}\`${name ? ` \`${name}\`` : ""}`;
    if (replacement === undefined) {
      breakingSurface.push(`🔴 ${at} — removed: \`${entry.line}\``);
      continue;
    }
    const move = `\`${entry.line}\` → \`${replacement}\``;
    // Only `?` moved: the shape is the same, so this is purely a requirement
    // being relaxed or tightened — and a relaxation breaks nobody.
    if (withoutOptionals(entry.line) === withoutOptionals(replacement)) {
      const relaxed = optionals(replacement) > optionals(entry.line);
      if (relaxed) relaxations += 1;
      breakingSurface.push(`${relaxed ? "🟡" : "🔴"} ${at} — now ${relaxed ? "optional" : "required"}: ${move}`);
      continue;
    }
    breakingSurface.push(`🔴 ${at} — changed: ${move}`);
  }
}

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
  for (const method of removed) breakingSurface.push(`🔴 \`${method}\` no longer exists on the client`);
  if (added.length > 0 || removed.length > 0) {
    sections.push(
      "### Methods\n" + [...removed.map((m) => `- 🔴 \`${m}\` removed`), ...added.map((m) => `- 🟢 \`${m}\` added`)].join("\n"),
    );
  }
}

// --- Operations -------------------------------------------------------------

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

function operations(spec: Spec): Map<string, Operation> {
  const map = new Map<string, Operation>();
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
function parameterDetail(operation: string, before: unknown, after: unknown): string {
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
  const isRequired = (param: unknown) => (param as { required?: unknown } | undefined)?.required === true;
  const parts: string[] = [];
  for (const [key, { name }] of afterMap) if (!beforeMap.has(key)) parts.push(`+\`${name}\``);
  for (const [key, { name }] of beforeMap) {
    if (!afterMap.has(key)) {
      parts.push(`−\`${name}\``);
      breaking.push({ member: operation, kind: "parameter", detail: `\`${name}\`` });
    }
  }
  for (const [key, { name, value }] of afterMap) {
    const previous = beforeMap.get(key);
    if (!previous || same(previous.value, value)) continue;
    parts.push(`~\`${name}\``);
    // A new required parameter breaks every existing call; a widened optional
    // one does not, so only the transition into `required` is reported.
    if (isRequired(value) && !isRequired(previous.value)) {
      breaking.push({ member: operation, kind: "required", detail: `parameter \`${name}\`` });
    }
  }
  return `parameters: ${parts.join(" ")}`;
}

for (const [key, op] of [...oldOps].sort(([a], [b]) => a.localeCompare(b))) {
  if (!newOps.has(key)) {
    opLines.push(`- 🔴 \`${key}\` removed${op.summary ? ` — ${op.summary}` : ""}`);
    breaking.push({ member: key, kind: "endpoint", detail: op.summary ?? "" });
  }
}
for (const [key, op] of [...newOps].sort(([a], [b]) => a.localeCompare(b))) {
  const before = oldOps.get(key);
  if (!before) {
    opLines.push(`- 🟢 \`${key}\` added${op.summary ? ` — ${op.summary}` : ""}`);
  } else if (!same(before, op)) {
    const parts = [
      !same(before.summary, op.summary) && "summary",
      !same(before.description, op.description) && "description",
      !same(before.deprecated, op.deprecated) && (op.deprecated === true ? "⚠️ now deprecated" : "no longer deprecated"),
      !same(before.parameters, op.parameters) && parameterDetail(key, before.parameters, op.parameters),
      !same(before.requestBody, op.requestBody) && "request body",
      !same(before.responses, op.responses) && "responses",
    ].filter(Boolean);
    // Only unnamed metadata (operationId, tags, …) differs: skip rather than
    // emit a reasonless "changed" line — mirrors the schema section's guard.
    if (parts.length === 0) continue;
    if (op.deprecated === true && before.deprecated !== true) {
      deprecations.push(`⚠️ \`${key}\`${op.summary ? ` — ${op.summary}` : ""}`);
    }
    opLines.push(`- 🟡 \`${key}\` changed (${parts.join("; ")})`);
  }
}
if (opLines.length > 0) sections.push("### Operations\n" + opLines.join("\n"));

// --- Component schemas -------------------------------------------------------

interface LeafChange {
  path: string;
  before: unknown;
  after: unknown;
}

interface Leaves {
  added: string[];
  removed: string[];
  /** Leaves whose value differs — carries both sides so the PR can show them. */
  changed: LeafChange[];
  /** Arrays holding the same values in a new order: noise, not a change. */
  reordered: string[];
  /** Properties (and whole schemas) newly carrying `deprecated: true`. */
  deprecated: string[];
}

/**
 * True for OpenAPI's `deprecated` flag, false for a property whose name simply
 * *is* "deprecated" — which sits at `…properties.deprecated`, one segment on
 * from the flag's `…properties.<field>.deprecated`.
 */
const isDeprecatedFlag = (path: string): boolean => path.endsWith("deprecated") && !path.endsWith("properties.deprecated");

/**
 * Upstream announces some deprecations in prose instead of the `deprecated`
 * flag ("Deprecated. Use startDate and endDate instead." prepended to an
 * existing description). Without this those hide inside the collapsed docs
 * bucket and the PR never says the field is going away.
 */
const saysDeprecated = (text: unknown): boolean => /\bdeprecat(ed|ion)\b/i.test(String(text ?? ""));

/** Collects dotted paths of added/removed/changed leaves between two JSON nodes. */
function diffPaths(before: unknown, after: unknown, prefix: string, out: Leaves): void {
  if (same(before, after)) return;
  const bothObjects =
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after);
  if (!bothObjects) {
    // false → true reads as a deprecation; the reverse is a plain value change.
    if (isDeprecatedFlag(prefix) && after === true) out.deprecated.push(prefix);
    else out.changed.push({ path: prefix, before, after });
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
    // Same values, different order — say so, but out of the way: upstream
    // reshuffles `required` arrays constantly and none of it means anything.
    if (beforeSet.size === afterSet.size && [...beforeSet].every((v) => afterSet.has(v))) {
      out.reordered.push(prefix);
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
    if (!(key in b)) {
      if (isDeprecatedFlag(path) && a[key] === true) out.deprecated.push(path);
      else out.added.push(path);
    } else {
      diffPaths(b[key], a[key], path, out);
    }
  }
}

/**
 * Diff a group of named members (component schemas, requestBodies, parameters,
 * …): a 🟢/🔴 line per added/removed member, and a 🟡 line with per-leaf
 * +/−/~ detail per changed one. `label` prefixes each member name so a shared
 * requestBody reads `requestBodies.createInvoice`.
 */
// Strips the JSON-Schema boilerplate that bloats a leaf path so the diff reads
// as `transaction.description`, not `content.application/json.schema.properties
// .transaction.description`. `.items` is kept (array nesting is meaningful).
function tidyPath(path: string): string {
  return path
    .replace(/^content\.application\/json\.schema\./, "")
    .replace(/(^|\.)properties\./g, "$1")
    .replace(/^\.+|\.+$/g, "");
}

function memberLines(before: Record<string, unknown>, after: Record<string, unknown>, label = ""): string[] {
  const prefix = label ? `${label}.` : "";
  // Request-side members: a property gaining `required` breaks existing callers.
  // On a response schema the same edit only promises callers more.
  const requestSide = label === "requestBodies";
  const lines: string[] = [];
  for (const name of Object.keys(before).sort()) {
    if (!(name in after)) {
      lines.push(`- 🔴 \`${prefix}${name}\` removed`);
      breaking.push({ member: `${prefix}${name}`, kind: "member", detail: "" });
    }
  }
  for (const name of Object.keys(after).sort()) {
    if (!(name in before)) {
      lines.push(`- 🟢 \`${prefix}${name}\` added`);
      continue;
    }
    if (same(before[name], after[name])) continue;
    const out: Leaves = { added: [], removed: [], changed: [], reordered: [], deprecated: [] };
    diffPaths(before[name], after[name], "", out);
    const retyped = out.changed.filter((leaf) => !isProse(leaf.path));
    const prose = out.changed.filter((leaf) => isProse(leaf.path));
    // Wording that newly calls a field deprecated counts as a deprecation.
    for (const leaf of prose) {
      if (saysDeprecated(leaf.after) && !saysDeprecated(leaf.before)) out.deprecated.push(leaf.path);
    }
    const total = out.added.length + out.removed.length + out.changed.length + out.reordered.length + out.deprecated.length;
    // No leaf actually differs (only stringify-visible noise): don't emit a
    // detail-less change line.
    if (total === 0) continue;
    const member = `${prefix}${name}`;
    const paths = (list: string[]) => list.map((path) => `\`${tidyPath(path)}\``).join(", ");

    const detail: string[] = [];
    if (out.added.length > 0) detail.push(`  - 🟢 added (${out.added.length}): ${paths(out.added)}`);
    if (out.removed.length > 0) detail.push(`  - 🔴 removed (${out.removed.length}): ${paths(out.removed)}`);
    for (const leaf of retyped) {
      detail.push(`  - 🟠 retyped \`${tidyPath(leaf.path)}\`: ${renderValue(leaf.before)} → ${renderValue(leaf.after)}`);
    }
    // Strip the flag itself: the reader wants the field that is going away.
    // A prose-sourced entry ends in `.description`, a flag one in `.deprecated`;
    // either way the reader wants the field, not the leaf that announced it.
    const deprecatedFields = out.deprecated.map(
      (path) => tidyPath(path).replace(/\.?(deprecated|description|summary|title)$/, "") || "(whole schema)",
    );
    if (deprecatedFields.length > 0) {
      const list = deprecatedFields.map((field) => `\`${field}\``).join(", ");
      detail.push(`  - ⚠️ newly deprecated (${deprecatedFields.length}): ${list}`);
    }
    if (out.reordered.length > 0) {
      detail.push(`  - ⚪ reordered, same values (${out.reordered.length}): ${paths(out.reordered)}`);
    }
    if (prose.length > 0) {
      // Collapsed: the bulk of every diff, and never a contract change. Kept in
      // full — <details> hides it from the first read, it doesn't drop it.
      detail.push(
        [
          `  - 📝 docs reworded (${prose.length}):`,
          "    <details><summary>show wording</summary>",
          "",
          ...prose.map((leaf) => `    - \`${tidyPath(leaf.path)}\`<br>“${String(leaf.before)}”<br>→ “${String(leaf.after)}”`),
          "",
          "    </details>",
        ].join("\n"),
      );
    }
    lines.push([`- 🟡 **\`${member}\`** — ${total} leaf change${total === 1 ? "" : "s"}`, ...detail].join("\n"));

    for (const field of deprecatedFields) deprecations.push(`⚠️ \`${member}\`: \`${field}\``);
    for (const path of out.removed) {
      // `a.b.required: "id"` disappearing means `a.b.id` became optional — a
      // weaker promise to the caller, not a field that vanished.
      const relaxed = /^(.*?)required: "(.+)"$/.exec(tidyPath(path));
      if (relaxed) breaking.push({ member, kind: "relaxed", detail: `\`${relaxed[1]}${relaxed[2]}\`` });
      else breaking.push({ member, kind: "removed", detail: `\`${tidyPath(path)}\`` });
    }
    for (const leaf of retyped) {
      breaking.push({
        member,
        kind: "retyped",
        detail: `\`${tidyPath(leaf.path)}\` ${renderValue(leaf.before)} → ${renderValue(leaf.after)}`,
      });
    }
    if (requestSide) {
      // Added `required` entries arrive as `a.b.required: "field"` (the scalar
      // array branch above); report them as the property path they constrain.
      for (const path of out.added) {
        const required = /^(.*?)required: "(.+)"$/.exec(tidyPath(path));
        if (required) breaking.push({ member, kind: "required", detail: `\`${required[1]}${required[2]}\`` });
      }
    }
  }
  return lines;
}

const schemaLines = memberLines(oldSpec.components?.schemas ?? {}, newSpec.components?.schemas ?? {});
if (schemaLines.length > 0) sections.push("### Schemas\n" + schemaLines.join("\n"));

// --- Other components (requestBodies, parameters, responses, …) --------------
// Shared component objects referenced by $ref from operations: an operation's
// requestBody may be `{ $ref: "#/components/requestBodies/X" }`, so a change to
// X's content is invisible in the Operations diff and must be caught here.

const componentGroups = [...new Set([...Object.keys(oldSpec.components ?? {}), ...Object.keys(newSpec.components ?? {})])]
  .filter((group) => group !== "schemas")
  .sort();
const componentLines: string[] = [];
for (const group of componentGroups) {
  componentLines.push(...memberLines(oldSpec.components?.[group] ?? {}, newSpec.components?.[group] ?? {}, group));
}
if (componentLines.length > 0) sections.push("### Components\n" + componentLines.join("\n"));

// -----------------------------------------------------------------------------

/**
 * Trims at a line boundary and says so, for hosts that reject an over-long body
 * outright (GitHub PR bodies: 65536 characters). Never reached without an
 * explicit --max-chars.
 */
function withinLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const notice = "\n\n_…summary trimmed to fit the host's body limit — the full diff is in the PR's Files changed._";
  const cut = text.slice(0, Math.max(0, limit - notice.length));
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > 0 ? cut.slice(0, lastBreak) : cut) + notice;
}

if (deprecations.length > 0) {
  sections.unshift(
    [
      "### ⚠️ Newly deprecated",
      "",
      "Still works, still typed — but upstream has scheduled it for removal:",
      ...deprecations.map((line) => `- ${line}`),
    ].join("\n"),
  );
}

if (breakingSurface.length > 0 || breaking.length > 0) {
  const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
  // One line per member per kind: a payload reshape hits `getBooking` and
  // `getBookings` with the same six fields, and twelve near-identical lines
  // read as twelve problems instead of one.
  const wire = new Map<string, Map<WireBreak["kind"], string[]>>();
  for (const entry of breaking) {
    const kinds = wire.get(entry.member) ?? new Map<WireBreak["kind"], string[]>();
    kinds.set(entry.kind, [...(kinds.get(entry.kind) ?? []), entry.detail]);
    wire.set(entry.member, kinds);
  }
  const wireLines: string[] = [];
  for (const [member, kinds] of wire) {
    for (const [kind, details] of kinds) {
      const n = details.length;
      const list = details.join(", ");
      const at = `\`${member}\``;
      switch (kind) {
        case "member":
          wireLines.push(`- 🔴 ${at} removed entirely`);
          break;
        case "endpoint":
          wireLines.push(`- 🔴 ${at} removed${details[0] ? ` — ${details[0]}` : ""}`);
          break;
        case "parameter":
          wireLines.push(`- 🔴 ${at} — ${n} ${plural(n, "parameter")} removed: ${list}`);
          break;
        case "removed":
          wireLines.push(`- 🔴 ${at} — ${n} ${plural(n, "property", "properties")} removed: ${list}`);
          break;
        case "relaxed":
          wireLines.push(`- 🟡 ${at} — ${n} ${plural(n, "field")} no longer required, may be absent: ${list}`);
          break;
        case "retyped":
          wireLines.push(`- 🟠 ${at} — retyped: ${details.join("; ")}`);
          break;
        case "required":
          wireLines.push(`- ➕ ${at} — now required: ${list}`);
          break;
      }
    }
  }

  const counts: string[] = [];
  if (breakingSurface.length > 0) {
    const relaxed = relaxations > 0 ? ` (${relaxations} ${plural(relaxations, "relaxation")}, breaking nobody)` : "";
    counts.push(`${breakingSurface.length} compile-level${relaxed}`);
  }
  if (breaking.length > 0) counts.push(`${breaking.length} wire-level`);

  const parts = [`### ⚠️ Breaking — ${counts.join(", ")}`];
  if (breakingSurface.length > 0) {
    parts.push("", "**Compile-level** — generated TypeScript that moved:", ...breakingSurface.map((line) => `- ${line}`));
  }
  if (wireLines.length > 0) {
    parts.push("", "**Wire-level** — the endpoints and payloads themselves, whether or not the types moved:", ...wireLines);
  }
  sections.unshift(parts.join("\n"));
}

if (sections.length === 0) {
  console.log("_No operation, schema, component, or method changes — only key reordering or top-level metadata (info, tags)._");
} else {
  console.log(withinLimit(sections.join("\n\n"), maxChars));
}
