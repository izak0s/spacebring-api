/**
 * Guards the generated API surface. After a regen, this suite fails when:
 * - an operation disappears from the facade (coverage count vs the spec)
 * - a method or namespace gets renamed (surface snapshot)
 *
 * A legitimate upstream API change updates the snapshot via `vitest -u` —
 * the snapshot diff in the regen PR then documents the surface change.
 */
import { readFileSync } from "node:fs";
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
});
