/**
 * Turns a spec operation into everything the emitter needs: namespace chain,
 * parameter groups, envelope shape (pagination/unwrap), and the deterministic
 * facade method name derived from path shape + operationId verb.
 */
import { camelCase, firstWord, pascalCase, singular } from "./naming.js";
import {
  type HttpMethod,
  resolveRef,
  type SpecOperation,
  type SpecParameter,
  spec,
  specPaths,
  TS_TYPES,
  warnings,
} from "./spec.js";
import { upperFirst } from "./text.js";

export interface PaginationInfo {
  itemsKey: string;
  /** Component-schema name the list item `$ref`s to (e.g. "subscription"), if any. */
  itemsSchemaRef?: string;
  /**
   * Envelope properties in declaration order, so list() can be annotated with a
   * readable literal type ({ bookings?: Booking[]; nextPageToken?: string })
   * instead of the operations[...] indexed-access soup.
   */
  props: { key: string; optional: boolean; scalar?: string }[];
}

/** One property of a multi-property success envelope ({ activity, ticket }). */
export interface EnvelopeProp {
  key: string;
  optional: boolean;
  /** TS scalar type ("string", "boolean[]") when the property isn't an entity. */
  scalar?: string;
  /** Set when the property is an object or array-of-object: it yields an entity alias. */
  entity?: { isArray: boolean; schemaRef?: string };
}

interface EnvelopeInfo {
  pagination?: PaginationInfo;
  /** Set when the success envelope has a single property: the facade returns it directly. */
  unwrapKey?: string;
  /** True when the unwrapped property is an array (non-paginated list endpoints). */
  unwrapIsArray?: boolean;
  /** Component-schema name the unwrapped entity (or its array item) `$ref`s to, if any. */
  unwrapSchemaRef?: string;
  /** Set for multi-property envelopes: returned whole, re-stated as a literal type. */
  multiProps?: EnvelopeProp[];
  /**
   * Set when a multi-property response is a bare entity, not an envelope — the
   * whole schema is type-identical to a same/namespace-named component
   * (createBenefit returns the benefit itself). Return type becomes its alias.
   */
  bareSchemaRef?: string;
}

/** Component name if `node` is a `$ref` into components/schemas, else undefined. */
function schemaRefName(node: unknown): string | undefined {
  const ref = (node as { $ref?: unknown } | null | undefined)?.$ref;
  if (typeof ref !== "string") return undefined;
  const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
  return match?.[1];
}

/** Type-relevant canonical form: drops descriptions, sorts keys. */
function canonicalSchema(node: unknown): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as object).sort()) {
        if (key === "description") continue;
        out[key] = strip((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(strip(node));
}

/**
 * The canonical component schema name for an entity node. This spec inlines
 * entity objects into responses rather than `$ref`-ing the component, so we
 * match by name (the property key) and only accept the component when it's
 * type-identical to the inline shape — otherwise fall back to the operation
 * form, keeping the generated type faithful to the actual response.
 */
function entityComponentRef(
  candidateName: string,
  entityNode: unknown,
  namespace: string[],
  byNameOnly = false,
): string | undefined {
  const direct = schemaRefName(entityNode);
  if (direct) return direct;
  const schemas = spec.components?.schemas as Record<string, unknown> | undefined;
  if (!schemas) return undefined;
  const inline = canonicalSchema(resolveRef(entityNode));
  // Prefer a same-named component; the property key (e.g. "category") often
  // differs from the component name (e.g. "shopCategory"), so also try the key
  // qualified by each namespace segment (innermost first: "shop" + "category"
  // -> "shopCategory"), then accept a uniquely-matching component by
  // structure. Ambiguous matches are skipped. `byNameOnly` skips the
  // structural try — used for whole-response matching, where it would pick up
  // op-named envelope components ("getContract") with unusable names.
  const candidates = [candidateName, ...[...namespace].reverse().map((segment) => singular(segment) + upperFirst(candidateName))];
  for (const name of candidates) {
    if (schemas[name] && canonicalSchema(schemas[name]) === inline) return name;
  }
  if (byNameOnly) return undefined;
  const matches = Object.keys(schemas).filter((name) => canonicalSchema(schemas[name]) === inline);
  return matches.length === 1 ? matches[0] : undefined;
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
  /**
   * `unwrapKey` mirrors the response-envelope unwrap on the request side: a
   * single-property body ({ plan: {...} }) is taken as the inner value and the
   * facade wraps it; multi-property bodies are passed through as-is.
   */
  body: { required: boolean; unwrapKey?: string } | undefined;
  pagination: PaginationInfo | undefined;
  unwrapKey: string | undefined;
  unwrapIsArray: boolean;
  unwrapSchemaRef: string | undefined;
  multiProps: EnvelopeProp[] | undefined;
  bareSchemaRef: string | undefined;
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
    ? resolveRef<{ required?: boolean; content?: Record<string, { schema?: unknown }> }>(op.requestBody)
    : undefined;

  for (const param of parameters) {
    if (param.in === "header" && param.required && param.name !== "spacebring-network-id") {
      warnings.push(`${op.operationId}: required header ${param.name} not covered by client defaults`);
    }
  }

  const envelope = analyzeEnvelope(op, namespace);

  return {
    path,
    method,
    op,
    namespace,
    rest,
    pathParams: parameters.filter((p) => p.in === "path"),
    queryParams: parameters.filter((p) => p.in === "query"),
    requiredNetworkHeader: parameters.some((p) => p.in === "header" && p.required && p.name === "spacebring-network-id"),
    body: requestBody ? { required: requestBody.required === true, unwrapKey: bodyUnwrapKey(requestBody) } : undefined,
    pagination: envelope.pagination,
    unwrapKey: envelope.unwrapKey,
    unwrapIsArray: envelope.unwrapIsArray === true,
    unwrapSchemaRef: envelope.unwrapSchemaRef,
    multiProps: envelope.multiProps,
    bareSchemaRef: envelope.bareSchemaRef,
  };
}

function isParam(segment: string): boolean {
  return segment.startsWith("{");
}

/** Classifies one property of a multi-property success envelope. */
function envelopeProp(key: string, node: unknown, required: Set<string>, namespace: string[]): EnvelopeProp {
  const rawProp = node as { items?: unknown };
  const propSchema = resolveRef<{ type?: string }>(rawProp);
  const prop: EnvelopeProp = { key, optional: !required.has(key), scalar: TS_TYPES[propSchema.type ?? ""] };
  if (propSchema.type === "object") {
    prop.entity = { isArray: false, schemaRef: entityComponentRef(key, rawProp, namespace) };
  } else if (propSchema.type === "array" && rawProp.items) {
    const itemSchema = resolveRef<{ type?: string }>(rawProp.items);
    if (itemSchema.type === "object") {
      prop.entity = { isArray: true, schemaRef: entityComponentRef(singular(key), rawProp.items, namespace) };
    } else {
      const item = TS_TYPES[itemSchema.type ?? ""];
      prop.scalar = item ? `${item}[]` : undefined;
    }
  }
  return prop;
}

/** The single property key of a request-body schema, if it has exactly one. */
function bodyUnwrapKey(requestBody: { content?: Record<string, { schema?: unknown }> }): string | undefined {
  const schema = requestBody.content?.["application/json"]?.schema;
  if (!schema) return undefined;
  const resolved = resolveRef<{ properties?: Record<string, unknown> }>(schema);
  const keys = resolved.properties ? Object.keys(resolved.properties) : [];
  return keys.length === 1 ? keys[0] : undefined;
}

function analyzeEnvelope(op: SpecOperation, namespace: string[]): EnvelopeInfo {
  const success = (op.responses["200"] ?? op.responses["201"]) as { content?: Record<string, { schema?: unknown }> } | undefined;
  const schema = success?.content?.["application/json"]?.schema;
  if (!schema) return {};
  const resolved = resolveRef<{ properties?: Record<string, { type?: string }>; required?: string[] }>(schema);
  const properties = resolved.properties;
  if (!properties) return {};

  if (!properties.nextPageToken) {
    const keys = Object.keys(properties);
    if (keys.length === 0) return {};
    if (keys.length === 1) {
      // Single-property envelope ({ subscription: {...} }, { locations: [...] }):
      // the facade returns the property directly.
      const rawProp = properties[keys[0]] as { items?: unknown };
      const propSchema = resolveRef<{ type?: string }>(rawProp);
      const isArray = propSchema.type === "array";
      // The entity is the property itself (object) or its array item.
      const unwrapSchemaRef = isArray
        ? entityComponentRef(singular(keys[0]), rawProp.items, namespace)
        : entityComponentRef(keys[0], rawProp, namespace);
      return { unwrapKey: keys[0], unwrapIsArray: isArray, unwrapSchemaRef };
    }
    // Bare entity response: the whole schema is a component (createBenefit
    // returns the benefit itself, flat). Name-only match — see entityComponentRef.
    const lastSegment = namespace[namespace.length - 1];
    const bareSchemaRef = lastSegment ? entityComponentRef(singular(lastSegment), schema, namespace, true) : undefined;
    if (bareSchemaRef) return { bareSchemaRef };
    // Multi-property envelope ({ activity, ticket }): returned whole; each
    // object/array-of-object property becomes an entity alias so the return
    // type can be re-stated as a readable literal. Only pure envelopes (every
    // property an object or array of objects) qualify — a response mixing
    // scalars is an inline entity we can't name, left as the operation type.
    const required = new Set(resolved.required ?? []);
    const props = keys.map((key) => envelopeProp(key, properties[key], required, namespace));
    if (props.every((prop) => prop.entity)) return { multiProps: props };
    return {};
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
  const itemsSchemaRef = entityComponentRef(
    singular(arrayKeys[0]),
    (properties[arrayKeys[0]] as { items?: unknown }).items,
    namespace,
  );
  return { pagination: { itemsKey: arrayKeys[0], itemsSchemaRef, props } };
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
