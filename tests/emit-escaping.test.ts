import { describe, expect, it, vi } from "vitest";
import type { AnalyzedOp } from "../codegen/facade/analyze.js";
import { emitMethod } from "../codegen/facade/emit.js";
import type { SpecOperation } from "../codegen/facade/spec.js";

// A compromised upstream spec is untrusted input; property names, operationIds,
// and paths flow into generated source (some into runtime string arguments that
// ship in dist). None may break out of their string literal.
const MALICIOUS = 'x"); process.exit(1); ("';

function analyzedOp(overrides: Partial<AnalyzedOp>): AnalyzedOp {
  const op: SpecOperation = {
    operationId: "getThings",
    responses: { 200: { content: { "application/json": {} } } },
  } as unknown as SpecOperation;
  return {
    path: "/things/v1",
    method: "get",
    op,
    namespace: ["things"],
    rest: [],
    pathParams: [],
    queryParams: [],
    requiredNetworkHeader: false,
    body: undefined,
    pagination: undefined,
    unwrapKey: undefined,
    unwrapIsArray: false,
    unwrapSchemaRef: undefined,
    ...overrides,
  };
}

describe("emit escaping", () => {
  it("escapes a malicious unwrapKey in the runtime unwrapProp argument", () => {
    const [method] = emitMethod(analyzedOp({ unwrapKey: MALICIOUS }), "get", undefined, undefined, undefined);
    expect(method.code).toContain(JSON.stringify(MALICIOUS));
    // The naive `"${value}"` sink would let the `");` sequence break out.
    expect(method.code).not.toContain(`"${MALICIOUS}"`);
  });

  it("escapes a malicious operationId in the response type index", () => {
    const op = { operationId: MALICIOUS, responses: { 200: { content: { "application/json": {} } } } };
    const [method] = emitMethod(
      analyzedOp({ op: op as unknown as SpecOperation, body: { required: true } }),
      "get",
      undefined,
      undefined,
      undefined,
    );
    expect(method.code).toContain(JSON.stringify(MALICIOUS));
    expect(method.code).not.toContain(`"${MALICIOUS}"`);
  });

  it("escapes a malicious path in the client call and error label", () => {
    const path = `/things/v1", evil(), ("`;
    const [method] = emitMethod(analyzedOp({ path }), "get", undefined, undefined, undefined);
    expect(method.code).toContain(JSON.stringify(path));
    expect(method.code).not.toContain(`("${path}"`);
  });

  it("escapes a malicious pagination itemsKey in the runtime paginate argument", () => {
    const pagination = { itemsKey: MALICIOUS, props: [{ key: MALICIOUS, optional: true }] };
    const methods = emitMethod(analyzedOp({ pagination, unwrapKey: undefined }), "list", undefined, undefined, undefined);
    const iterate = methods.find((m) => m.usesPaginate);
    expect(iterate?.code).toContain(JSON.stringify(MALICIOUS));
    expect(iterate?.code).not.toContain(`"${MALICIOUS}"`);
  });

  it("rejects a non-identifier path parameter name instead of emitting it", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() =>
      emitMethod(
        analyzedOp({ path: "/things/v1/{x}", pathParams: [{ name: MALICIOUS, in: "path" }] as never }),
        "get",
        undefined,
        undefined,
        undefined,
      ),
    ).toThrow("exit");
    exit.mockRestore();
  });
});
