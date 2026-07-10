/**
 * Turns a spec operation into everything the emitter needs: namespace chain,
 * parameter groups, envelope shape (pagination/unwrap), and the deterministic
 * facade method name derived from path shape + operationId verb.
 */
import { camelCase, firstWord, pascalCase, singular } from "./naming.js";
import { type HttpMethod, resolveRef, type SpecOperation, type SpecParameter, specPaths, TS_TYPES, warnings } from "./spec.js";

export interface PaginationInfo {
  itemsKey: string;
  /**
   * Envelope properties in declaration order, so list() can be annotated with a
   * readable literal type ({ bookings?: Booking[]; nextPageToken?: string })
   * instead of the operations[...] indexed-access soup.
   */
  props: { key: string; optional: boolean; scalar?: string }[];
}

interface EnvelopeInfo {
  pagination?: PaginationInfo;
  /** Set when the success envelope has a single property: the facade returns it directly. */
  unwrapKey?: string;
  /** True when the unwrapped property is an array (non-paginated list endpoints). */
  unwrapIsArray?: boolean;
}

export interface AnalyzedOp {
  path: string;
  method: HttpMethod;
  op: SpecOperation;
  namespace: string[]; // camelCased namespace chain, e.g. ["billing", "invoices", "items"]
  rest: string[]; // path segments after the namespace, e.g. ["{invoiceId}", "pay"]
  pathParams: SpecParameter[];
  queryParams: SpecParameter[];
  requiredNetworkHeader: boolean;
  body: { required: boolean } | undefined;
  pagination: PaginationInfo | undefined;
  unwrapKey: string | undefined;
  unwrapIsArray: boolean;
}

export function analyze(path: string, method: HttpMethod, op: SpecOperation): AnalyzedOp {
  const segments = path.split("/").filter(Boolean);
  const versionIndex = segments.indexOf("v1");
  if (versionIndex === -1) throw new Error(`Path without /v1 segment: ${path}`);

  const namespace = segments.slice(0, versionIndex).map(camelCase);
  let rest = segments.slice(versionIndex + 1);
  let prefix = "/" + segments.slice(0, versionIndex + 1).join("/");

  // Promote literal sub-collections (e.g. "items", "balances") that have their
  // own parameterized paths into nested namespaces.
  while (rest.length > 0 && !isParam(rest[0]) && specPaths.some((p) => p.startsWith(`${prefix}/${rest[0]}/{`))) {
    namespace.push(camelCase(rest[0]));
    prefix = `${prefix}/${rest[0]}`;
    rest = rest.slice(1);
  }

  const parameters = (op.parameters ?? []).map((p) => resolveRef<SpecParameter>(p));
  const requestBody = op.requestBody
    ? resolveRef<{ required?: boolean }>(op.requestBody)
    : undefined;

  for (const param of parameters) {
    if (param.in === "header" && param.required && param.name !== "spacebring-network-id") {
      warnings.push(`${op.operationId}: required header ${param.name} not covered by client defaults`);
    }
  }

  const envelope = analyzeEnvelope(op);

  return {
    path,
    method,
    op,
    namespace,
    rest,
    pathParams: parameters.filter((p) => p.in === "path"),
    queryParams: parameters.filter((p) => p.in === "query"),
    requiredNetworkHeader: parameters.some((p) => p.in === "header" && p.required && p.name === "spacebring-network-id"),
    body: requestBody ? { required: requestBody.required === true } : undefined,
    pagination: envelope.pagination,
    unwrapKey: envelope.unwrapKey,
    unwrapIsArray: envelope.unwrapIsArray === true,
  };
}

function isParam(segment: string): boolean {
  return segment.startsWith("{");
}

function analyzeEnvelope(op: SpecOperation): EnvelopeInfo {
  const success = (op.responses["200"] ?? op.responses["201"]) as
    | { content?: Record<string, { schema?: unknown }> }
    | undefined;
  const schema = success?.content?.["application/json"]?.schema;
  if (!schema) return {};
  const resolved = resolveRef<{ properties?: Record<string, { type?: string }>; required?: string[] }>(schema);
  const properties = resolved.properties;
  if (!properties) return {};

  if (!properties.nextPageToken) {
    // Single-property envelope ({ subscription: {...} }, { locations: [...] }):
    // the facade returns the property directly.
    const keys = Object.keys(properties);
    if (keys.length !== 1) return {};
    const propSchema = resolveRef<{ type?: string }>(properties[keys[0]]);
    return { unwrapKey: keys[0], unwrapIsArray: propSchema.type === "array" };
  }

  const arrayKeys = Object.keys(properties).filter((key) => resolveRef<{ type?: string }>(properties[key]).type === "array");
  if (arrayKeys.length !== 1) {
    warnings.push(`${op.operationId}: paginated response with ${arrayKeys.length} array properties, iterate() skipped`);
    return {};
  }
  const required = new Set(resolved.required ?? []);
  const props = Object.keys(properties).map((key) => {
    const propSchema = resolveRef<{ type?: string }>(properties[key]);
    return { key, optional: !required.has(key), scalar: TS_TYPES[propSchema.type ?? ""] };
  });
  return { pagination: { itemsKey: arrayKeys[0], props } };
}

export function methodName(analyzed: AnalyzedOp): string {
  const { rest, method, op, pagination } = analyzed;
  const shape = rest.map((segment) => (isParam(segment) ? "{}" : "lit")).join("/");
  const literal = rest.find((segment) => !isParam(segment));

  switch (shape) {
    case "":
      if (method === "get") return "list";
      if (method === "post") return "create";
      break;
    case "{}":
      if (method === "get") return "get";
      if (method === "delete") return "delete";
      if (method === "put" || method === "patch") return "update";
      break;
    case "lit":
    case "{}/lit": {
      const lit = literal!;
      if (method === "get") return (pagination ? "list" : "get") + pascalCase(lit);
      // Action verb: "/pay" on payInvoice, "/cancel_payment" on cancelInvoicePayment.
      if (firstWord(camelCase(lit)) === firstWord(op.operationId)) return camelCase(lit);
      // Noun collections without their own id paths: "/likes" on createLikeForPost.
      const verb = firstWord(op.operationId);
      if (verb === "create" || verb === "delete") return verb + pascalCase(singular(lit));
      if (verb === "update") return "update" + pascalCase(lit);
      break;
    }
    case "{}/lit/{}": {
      const lit = literal!;
      if (method === "get") return "get" + pascalCase(singular(lit));
      if (method === "delete") return "delete" + pascalCase(singular(lit));
      if (method === "put" || method === "patch") return "update" + pascalCase(singular(lit));
      if (method === "post") return "create" + pascalCase(singular(lit));
      break;
    }
  }

  warnings.push(`${op.operationId}: no naming rule for ${method.toUpperCase()} ${analyzed.path}, emitted as ${op.operationId}()`);
  return op.operationId;
}
