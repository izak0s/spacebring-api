import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, parseSurface } from "../codegen/classify-surface.js";

const verdict = (before: string, after: string) => classify(parseSurface(before), parseSurface(after)).verdict;

const base = `// benefits.ts
export type Benefit = NonNullable<operations["getBenefit"]["responses"][200]["content"]["application/json"]["benefit"]>;
export interface GetBenefitsQuery {
  categoryRef?: string;
  locationRef: string;
}
export function createBenefits(client: Client<paths>, defaults: SpacebringDefaults) {
  return {
    async get(benefitId: string, options?: SpacebringRequestOptions): Promise<Benefit>
    async delete(id: string, options?: SpacebringRequestOptions): Promise<undefined>
    categories: {
      async delete(id: string, options?: SpacebringRequestOptions): Promise<undefined>
    },
  };
}
`;

describe("classify-surface", () => {
  it("identical snapshots are unchanged", () => {
    expect(verdict(base, base)).toBe("unchanged");
  });

  it("the real committed snapshot classifies as unchanged against itself", () => {
    const real = readFileSync(new URL("./__snapshots__/typed-surface.txt", import.meta.url), "utf8");
    expect(verdict(real, real)).toBe("unchanged");
  });

  it("a new optional property on an existing interface is additive", () => {
    const after = base.replace("  categoryRef?: string;", "  categoryRef?: string;\n  featured?: boolean;");
    expect(verdict(base, after)).toBe("additive");
  });

  it("a new method is additive", () => {
    const after = base.replace(
      "    async get(benefitId",
      "    async list(query?: GetBenefitsQuery, options?: SpacebringRequestOptions): Promise<Benefit[]>\n    async get(benefitId",
    );
    expect(verdict(base, after)).toBe("additive");
  });

  it("a brand-new interface with required properties is additive", () => {
    const after = base + "export interface GetPlansQuery {\n  locationRef: string;\n}\n";
    expect(verdict(base, after)).toBe("additive");
  });

  it("a removed method is breaking", () => {
    const after = base.replace("    async get(benefitId: string, options?: SpacebringRequestOptions): Promise<Benefit>\n", "");
    expect(verdict(base, after)).toBe("breaking");
  });

  it("a changed signature is breaking", () => {
    const after = base.replace("Promise<Benefit>", "Promise<Benefit[]>");
    expect(verdict(base, after)).toBe("breaking");
  });

  it("a required property added to an existing interface is breaking", () => {
    const after = base.replace("  categoryRef?: string;", "  categoryRef?: string;\n  networkRef: string;");
    expect(verdict(base, after)).toBe("breaking");
  });

  it("an optional property made required is breaking", () => {
    const after = base.replace("  categoryRef?: string;", "  categoryRef: string;");
    expect(verdict(base, after)).toBe("breaking");
  });

  it("losing one of two textually identical methods in different namespaces is breaking", () => {
    // benefits.delete and benefits.categories.delete share the same signature
    // line; only the nested one is removed.
    const after = base.replace(
      "    categories: {\n      async delete(id: string, options?: SpacebringRequestOptions): Promise<undefined>\n    },\n",
      "    categories: {\n    },\n",
    );
    expect(verdict(base, after)).toBe("breaking");
  });
});
