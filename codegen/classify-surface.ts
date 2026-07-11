/**
 * Classifies the diff between two typed-surface snapshots for the regen
 * workflow's auto-merge gate.
 *
 *   tsx codegen/classify-surface.ts <old-typed-surface> <new-typed-surface>
 *
 * Prints exactly one word to stdout:
 * - `unchanged` — snapshots are equivalent
 * - `additive`  — only new lines: new methods, new entity aliases, new query
 *   interfaces, or new *optional* properties on existing query interfaces.
 *   Safe to auto-merge: existing consumer code keeps compiling.
 * - `breaking`  — an existing line disappeared (removed/renamed method,
 *   changed signature, changed/removed property) or a *required* property
 *   was added to a pre-existing interface (existing calls would stop
 *   typechecking).
 *
 * Reasons for a `breaking` verdict go to stderr so they show up in the
 * Actions log.
 *
 * Lines are compared as a multiset keyed by their structural context
 * (file → interface, or file → function → nested namespace path), not as a
 * flat set: many method signatures (e.g. `async delete(id, options?)`) are
 * textually identical across resources, and a flat set would miss one of
 * them disappearing.
 */
import { readFileSync } from "node:fs";

interface Surface {
  /** `context|line` → occurrence count */
  lines: Map<string, number>;
  /** `file|interface Name` keys of all interfaces */
  interfaces: Set<string>;
  /** required (non-optional) property lines, as { interfaceKey, key } */
  requiredProps: { interfaceKey: string; key: string }[];
}

const PROP = /^("[^"]+"|[A-Za-z_$][\w$]*)(\?)?:/;

export function parseSurface(content: string): Surface {
  const lines = new Map<string, number>();
  const interfaces = new Set<string>();
  const requiredProps: Surface["requiredProps"] = [];

  let file = "";
  let block: { kind: "interface" | "fn"; name: string } | null = null;
  const nesting: string[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;

    let context: string;
    if (/^\/\/ \S+\.ts$/.test(line)) {
      file = line.slice(3);
      block = null;
      nesting.length = 0;
      continue;
    }
    const interfaceMatch = line.match(/^export interface (\w+) \{$/);
    const fnMatch = line.match(/^export function (\w+)\(/);
    if (interfaceMatch) {
      block = { kind: "interface", name: interfaceMatch[1] };
      interfaces.add(`${file}|interface ${block.name}`);
      continue;
    }
    if (fnMatch) {
      block = { kind: "fn", name: fnMatch[1] };
      nesting.length = 0;
      continue;
    }
    if (block === null) {
      context = `${file}|top`;
    } else if (block.kind === "interface") {
      if (line === "}") {
        block = null;
        continue;
      }
      const interfaceKey = `${file}|interface ${block.name}`;
      context = interfaceKey;
      const prop = line.match(PROP);
      if (prop && prop[2] === undefined) requiredProps.push({ interfaceKey, key: `${context}|${line}` });
    } else {
      if (/^\}[,;]?$/.test(line)) {
        if (nesting.length > 0) nesting.pop();
        else block = null;
        continue;
      }
      context = `${file}|fn ${block.name}|${nesting.join("/")}`;
      if (line.endsWith("{")) {
        nesting.push(line.slice(0, -1).trim());
        continue;
      }
    }

    const key = `${context}|${line}`;
    lines.set(key, (lines.get(key) ?? 0) + 1);
  }
  return { lines, interfaces, requiredProps };
}

export function classify(before: Surface, after: Surface): { verdict: "unchanged" | "additive" | "breaking"; reasons: string[] } {
  const reasons: string[] = [];
  for (const [key, count] of before.lines) {
    if ((after.lines.get(key) ?? 0) < count) reasons.push(`removed or changed: ${key}`);
  }
  let added = false;
  for (const [key, count] of after.lines) {
    if (count > (before.lines.get(key) ?? 0)) added = true;
  }
  for (const prop of after.requiredProps) {
    if (!before.lines.has(prop.key) && before.interfaces.has(prop.interfaceKey)) {
      reasons.push(`required property added to existing interface: ${prop.key}`);
    }
  }
  if (reasons.length > 0) return { verdict: "breaking", reasons };
  return { verdict: added ? "additive" : "unchanged", reasons };
}

// tsx runs this file directly in CI; vitest imports it, so guard the CLI part.
if (process.argv[1]?.endsWith("classify-surface.ts")) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error("Usage: tsx codegen/classify-surface.ts <old-typed-surface> <new-typed-surface>");
    process.exit(1);
  }
  const before = parseSurface(readFileSync(oldPath, "utf8"));
  const after = parseSurface(readFileSync(newPath, "utf8"));
  const { verdict, reasons } = classify(before, after);
  for (const reason of reasons) console.error(reason);
  console.log(verdict);
}
