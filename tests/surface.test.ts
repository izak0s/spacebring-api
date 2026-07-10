/**
 * Guards the generated API surface. After a regen, this suite fails when:
 * - an operation disappears from the facade (coverage count vs the spec)
 * - a method or namespace gets renamed (surface snapshot)
 * - any signature or exported type changes (typed-surface file snapshot):
 *   catches generator regressions the name-only snapshot can't see
 *
 * A legitimate upstream API change updates the snapshots via `vitest -u` —
 * the snapshot diff in the regen PR then documents the surface change.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Spacebring } from "../src/index.js";

const sb = new Spacebring({ clientId: "a", clientSecret: "b", fetch: (async () => new Response("{}")) as typeof fetch });

function surface(node: object, prefix = ""): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "function") lines.push(`${prefix}${key}()`);
    else if (value && typeof value === "object") lines.push(...surface(value, `${prefix}${key}.`));
  }
  return lines;
}

const { raw, ...resources } = sb;
const methods = surface(resources);

describe("generated API surface", () => {
  it("covers every operation in the spec", () => {
    const spec = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "openapi.json"), "utf8"));
    let specOps = 0;
    for (const path of Object.values(spec.paths) as Record<string, unknown>[]) {
      for (const method of ["get", "put", "post", "delete", "patch"]) {
        if (path[method]) specOps += 1;
      }
    }
    const facadeOps = methods.filter((name) => !/(^|\.)iterate/.test(name)).length;
    expect(specOps).toBeGreaterThan(0);
    expect(facadeOps).toBe(specOps);
  });

  it("keeps paginated lists iterable", () => {
    // Every iterate() must sit next to the list method it pages through.
    for (const iterate of methods.filter((name) => /(^|\.)iterate/.test(name))) {
      const list = iterate.replace(/iterate(?=[A-Z(])/, "list");
      expect(methods, `${iterate} has no matching ${list}`).toContain(list);
    }
  });

  it("matches the recorded surface", () => {
    expect(methods.sort().join("\n")).toMatchSnapshot();
  });

  it("matches the recorded typed surface", async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "generated", "resources");
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && file !== "index.ts")
      .sort();
    const surface = files
      .map((file) => `// ${file}\n${typeSurface(readFileSync(join(dir, file), "utf8"))}`)
      .join("\n\n");
    await expect(surface).toMatchFileSnapshot("__snapshots__/typed-surface.txt");
  });
});

/**
 * Reduces a generated resource file to its type-level surface: signatures,
 * exported types/interfaces, and namespace structure — no doc comments,
 * imports, or method bodies. Relies on the generator's fixed output format
 * (one-line signatures ending in " {", bodies closed by "}," at the same
 * indentation).
 */
function typeSurface(source: string): string {
  const out: string[] = [];
  let bodyEnd: string | undefined;
  for (const line of source.split("\n")) {
    if (bodyEnd !== undefined) {
      if (line === bodyEnd) bodyEnd = undefined;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("import ") || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    const method = /^(\s*)(?:async )?[\w$]+\(.*\{$/.exec(line);
    if (method && !trimmed.startsWith("export function")) {
      out.push(line.replace(/ \{$/, ""));
      bodyEnd = `${method[1]}},`;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
