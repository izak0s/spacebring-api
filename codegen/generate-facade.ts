/**
 * Generates the nested resource facade (src/generated/resources/) from spec/openapi.json.
 *
 * Naming is fully deterministic:
 * - Namespaces come from path segments before "/v1" (plus literal sub-collections
 *   such as "items" that have their own "/{id}" paths).
 * - Collection GET -> list (+ iterate when the response is paginated), POST -> create.
 * - Item GET/PUT/PATCH/DELETE -> get/update/update/delete.
 * - Action segments (e.g. "/pay", "/cancel_payment") -> camelCase verb, validated
 *   against the operationId's leading verb.
 * - Anything that matches no rule is emitted under its full operationId and reported,
 *   so no operation is ever dropped silently.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { camelCase, firstWord, pascalCase, singular } from "./naming.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = join(ROOT, "spec", "openapi.json");
const OUT_DIR = join(ROOT, "src", "generated", "resources");

type HttpMethod = "get" | "put" | "post" | "delete" | "patch";
const HTTP_METHODS: HttpMethod[] = ["get", "put", "post", "delete", "patch"];

interface SpecParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  deprecated?: boolean;
  description?: string;
  schema?: { type?: string };
}

interface SpecOperation {
  operationId: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: SpecParameter[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
}

interface Spec {
  paths: Record<string, Partial<Record<HttpMethod, SpecOperation>>>;
  components?: Record<string, Record<string, unknown>>;
}

const spec: Spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const specPaths = Object.keys(spec.paths).sort();

function resolveRef<T>(node: unknown): T {
  let current = node as Record<string, unknown>;
  const seen = new Set<string>();
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) throw new Error(`Circular $ref chain at ${current.$ref}`);
    seen.add(current.$ref);
    const parts = current.$ref.replace(/^#\//, "").split("/");
    let target: unknown = spec;
    for (const part of parts) target = (target as Record<string, unknown>)[part];
    current = target as Record<string, unknown>;
  }
  return current as T;
}

// ---------------------------------------------------------------------------
// Operation analysis
// ---------------------------------------------------------------------------

interface PaginationInfo {
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

interface AnalyzedOp {
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

const warnings: string[] = [];

function analyze(path: string, method: HttpMethod, op: SpecOperation): AnalyzedOp {
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

// ---------------------------------------------------------------------------
// Method naming
// ---------------------------------------------------------------------------

function methodName(analyzed: AnalyzedOp): string {
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

// ---------------------------------------------------------------------------
// Namespace tree
// ---------------------------------------------------------------------------

interface EmittedMethod {
  name: string;
  code: string;
  usesPaginate: boolean;
  usesUnwrapProp: boolean;
}

interface TreeNode {
  methods: EmittedMethod[];
  children: Map<string, TreeNode>;
}

const newNode = (): TreeNode => ({ methods: [], children: new Map() });
const roots = new Map<string, TreeNode>();

function nodeFor(namespace: string[]): TreeNode {
  const [rootName, ...restNs] = namespace;
  let node: TreeNode | undefined = roots.get(rootName);
  if (!node) {
    node = newNode();
    roots.set(rootName, node);
  }
  let current: TreeNode = node;
  for (const part of restNs) {
    let child: TreeNode | undefined = current.children.get(part);
    if (!child) {
      child = newNode();
      current.children.set(part, child);
    }
    current = child;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Code emission
// ---------------------------------------------------------------------------

const TS_TYPES: Record<string, string> = { string: "string", integer: "number", number: "number", boolean: "boolean" };

// ---------------------------------------------------------------------------
// Named query types
//
// Every operation with query parameters gets an exported interface named after
// its operationId (getCreditsTransactions -> GetCreditsTransactionsQuery), so
// signatures read `query?: GetCreditsTransactionsQuery` instead of the
// operations[...] indexed-access soup. The interface is rebuilt from the spec's
// parameter schemas; the facade body still assigns it into openapi-fetch's
// schema-derived query type, so any divergence fails the typecheck.
// ---------------------------------------------------------------------------

interface QuerySchema {
  type?: string;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
}

function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Converts a query-parameter schema to a TS type; undefined = shape we don't handle. */
function queryParamType(schemaNode: unknown): string | undefined {
  const schema = resolveRef<QuerySchema>(schemaNode);
  let type: string | undefined;
  if (schema.enum) {
    type = schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  } else if (schema.type === "object" && schema.properties) {
    const required = new Set(schema.required ?? []);
    const parts: string[] = [];
    for (const [key, value] of Object.entries(schema.properties)) {
      const propType = queryParamType(value);
      if (!propType) return undefined;
      parts.push(`${quoteKey(key)}${required.has(key) ? "" : "?"}: ${propType}`);
    }
    type = `{ ${parts.join("; ")} }`;
  } else if (schema.type === "array" && schema.items) {
    const itemType = queryParamType(schema.items);
    type = itemType ? `${itemType}[]` : undefined;
  } else {
    type = TS_TYPES[schema.type ?? ""];
  }
  if (type && schema.nullable) type = `${type} | null`;
  return type;
}

function indentBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
}

/**
 * Spec descriptions are HTML with an OAuth-scopes section that doesn't apply
 * to this Basic-auth client; strip that, convert <code> to backticks, drop tags.
 */
function cleanDescription(html: string): string {
  return html
    .split(/<h3>OAuth<\/h3>/)[0]
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\//g, "*\\/")
    .trim();
}

function docComment(lines: string[]): string {
  const content = lines.filter((line) => line.length > 0);
  if (content.length === 0) return "";
  if (content.length === 1) return `/** ${content[0]} */\n`;
  return `/**\n${content.map((line) => ` * ${line}`).join("\n *\n")}\n */\n`;
}

function opDoc(op: SpecOperation, suffix = ""): string {
  const summary = op.summary ? cleanDescription(op.summary) : "";
  const description = op.description ? cleanDescription(op.description) : "";
  const lines = [summary + suffix];
  // Descriptions usually restate the summary; only keep genuinely new text.
  if (description && description !== summary && description !== `${summary}.`) lines.push(description);
  if (op.deprecated) lines.push("@deprecated Marked as deprecated in the OpenAPI spec.");
  return docComment(lines);
}

function successResponseStatus(op: SpecOperation): string | undefined {
  return Object.keys(op.responses)
    .filter((status) => /^\d+$/.test(status) && Number(status) >= 200 && Number(status) < 300)
    .sort((a, b) => Number(a) - Number(b))[0];
}

function successJsonType(op: SpecOperation): string {
  const status = successResponseStatus(op);
  if (!status) return "undefined";
  const response = op.responses[status] as { content?: Record<string, unknown> } | undefined;
  if (!response?.content?.["application/json"]) return "undefined";
  return `operations["${op.operationId}"]["responses"][${status}]["content"]["application/json"]`;
}

// ---------------------------------------------------------------------------
// Named entity aliases
//
// Every unwrapped payload property and every paginated items array yields a
// candidate entity type (e.g. "booking" / "bookings" -> Booking). Per node the
// best-documented source wins (get > list > create > update); names that
// collide across the package are disambiguated with namespace qualifiers
// (CreditTransaction, ShopCategory). Unresolvable clashes fail the build.
// ---------------------------------------------------------------------------

interface EntityCandidate {
  node: TreeNode;
  root: string;
  namespace: string[];
  base: string;
  /** Type expression the alias points at (already `[number]`-indexed for arrays). */
  expr: string;
  priority: number;
  opId: string;
}

interface Entity {
  name: string;
  expr: string;
  root: string;
  namespace: string[];
  candidateNames: string[];
  nameIndex: number;
}

function methodPriority(name: string): number {
  if (name === "get") return 0;
  if (name.startsWith("list") || name.startsWith("iterate")) return 1;
  if (name.startsWith("get")) return 2;
  if (name.startsWith("create")) return 3;
  if (name.startsWith("update")) return 4;
  return 5;
}

// Keys and namespace segments are already camelCase; pascalCase() would
// flatten their humps ("creditNotes" -> "Creditnotes"), so just upper-first.
function upperFirst(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function entityBase(key: string): string {
  return upperFirst(singular(key));
}

/** Progressively qualified names: Category -> BenefitCategory -> ... */
function candidateNames(namespace: string[], base: string): string[] {
  const names = [base];
  for (let i = namespace.length - 1; i >= 0; i -= 1) {
    const qualifier = upperFirst(singular(namespace[i]));
    const previous = names[names.length - 1];
    if (qualifier === base || previous.startsWith(qualifier)) continue;
    names.push(qualifier + previous);
  }
  return names;
}

function resolveEntities(candidates: EntityCandidate[]): Map<TreeNode, Map<string, Entity>> {
  // One entity per (node, base): the highest-priority candidate defines the alias.
  const byNode = new Map<TreeNode, Map<string, Entity>>();
  for (const candidate of [...candidates].sort((a, b) => a.priority - b.priority || a.opId.localeCompare(b.opId))) {
    let entities = byNode.get(candidate.node);
    if (!entities) {
      entities = new Map();
      byNode.set(candidate.node, entities);
    }
    if (!entities.has(candidate.base)) {
      const names = candidateNames(candidate.namespace, candidate.base);
      entities.set(candidate.base, {
        name: names[0],
        expr: candidate.expr,
        root: candidate.root,
        namespace: candidate.namespace,
        candidateNames: names,
        nameIndex: 0,
      });
    }
  }

  // Globally unique names: advance colliding entities through their qualifiers.
  const all = [...byNode.values()].flatMap((entities) => [...entities.values()]);
  for (let round = 0; round < 4; round += 1) {
    const groups = new Map<string, Entity[]>();
    for (const entity of all) {
      const group = groups.get(entity.name) ?? [];
      group.push(entity);
      groups.set(entity.name, group);
    }
    const clashes = [...groups.values()].filter((group) => group.length > 1);
    if (clashes.length === 0) return byNode;
    for (const group of clashes) {
      for (const entity of group) {
        if (entity.nameIndex + 1 >= entity.candidateNames.length) {
          console.error(`Cannot disambiguate entity type ${entity.name} (${entity.namespace.join(".")})`);
          process.exit(1);
        }
        entity.nameIndex += 1;
        entity.name = entity.candidateNames[entity.nameIndex];
      }
    }
  }
  console.error("Entity name resolution did not converge.");
  process.exit(1);
}

function emitMethod(
  analyzed: AnalyzedOp,
  name: string,
  entities: Map<string, Entity> | undefined,
  queryTypeName: string | undefined,
): EmittedMethod[] {
  const { op, method, path, pathParams, queryParams, requiredNetworkHeader, body, pagination, unwrapKey } = analyzed;
  // Runtime value comes from client-level config; openapi-fetch drops undefined header values.
  const headerPart = `header: { "spacebring-network-id": defaults.networkId as string }`;
  const hasQuery = queryParams.length > 0;
  const queryRequired = queryParams.some((p) => p.required);
  const queryType = queryTypeName ?? `operations["${op.operationId}"]["parameters"]["query"]`;
  const bodyType = `NonNullable<operations["${op.operationId}"]["requestBody"]>["content"]["application/json"]`;

  const args: string[] = pathParams.map((p) => `${p.name}: ${TS_TYPES[p.schema?.type ?? "string"] ?? "string"}`);
  if (body) args.push(`body${body.required ? "" : "?"}: ${bodyType}`);
  if (hasQuery) args.push(`query${queryRequired ? "" : "?"}: ${queryType}`);
  args.push("options?: SpacebringRequestOptions");

  const requestParts: string[] = [];
  const paramsParts: string[] = [];
  if (requiredNetworkHeader) paramsParts.push(headerPart);
  if (pathParams.length > 0) paramsParts.push(`path: { ${pathParams.map((p) => p.name).join(", ")} }`);
  if (hasQuery) paramsParts.push("query");
  if (paramsParts.length > 0) requestParts.push(`params: { ${paramsParts.join(", ")} }`);
  if (body) requestParts.push("body");
  requestParts.push("signal: options?.signal");
  const request = `{ ${requestParts.join(", ")} }`;

  const doc = opDoc(op);
  const responseType = successJsonType(op);
  const unwrapAlias = unwrapKey ? entities?.get(entityBase(unwrapKey))?.name : undefined;
  const rawUnwrapType = unwrapKey ? `NonNullable<${responseType}["${unwrapKey}"]>` : responseType;
  // Paginated envelopes are re-stated as a literal type using the entity alias
  // ({ bookings?: Booking[]; nextPageToken?: string }) — structurally identical
  // to the operations[...] type (typecheck enforces this), but readable on hover.
  const listAlias = !unwrapKey && pagination ? entities?.get(entityBase(pagination.itemsKey))?.name : undefined;
  const paginatedType =
    pagination && listAlias
      ? `{ ${pagination.props
          .map(
            (p) =>
              `${p.key}${p.optional ? "?" : ""}: ${
                p.key === pagination.itemsKey ? `${listAlias}[]` : (p.scalar ?? `${responseType}["${p.key}"]`)
              }`,
          )
          .join("; ")} }`
      : undefined;
  const returnType = unwrapKey
    ? unwrapAlias
      ? analyzed.unwrapIsArray
        ? `${unwrapAlias}[]`
        : unwrapAlias
      : rawUnwrapType
    : (paginatedType ?? responseType);
  // Attached to thrown SpacebringErrors so failures identify their operation.
  const opLabel = `${method.toUpperCase()} ${path}`;
  const call = `await client.${method.toUpperCase()}("${path}", ${request})`;
  const methods: EmittedMethod[] = [
    {
      name,
      usesPaginate: false,
      usesUnwrapProp: unwrapKey !== undefined,
      code:
        doc +
        `async ${name}(${args.join(", ")}): Promise<${returnType}> {\n` +
        `  return ${unwrapKey ? `unwrapProp(${call}, "${unwrapKey}", "${opLabel}")` : `unwrap(${call}, "${opLabel}")`};\n` +
        `},`,
    },
  ];

  // list -> iterate, listItems -> iterateItems: follows nextPageToken across pages.
  if (method === "get" && pagination && name.startsWith("list")) {
    const iterateName = "iterate" + name.slice("list".length);
    const iterateQueryType = queryTypeName
      ? `Omit<${queryTypeName}, "nextPageToken">`
      : `Omit<NonNullable<${queryType}>, "nextPageToken">`;
    const iterateArgs = [
      ...pathParams.map((p) => `${p.name}: ${TS_TYPES[p.schema?.type ?? "string"] ?? "string"}`),
      `query${queryRequired ? "" : "?"}: ${iterateQueryType}`,
      "options?: SpacebringRequestOptions",
    ];
    const iterateParamsParts: string[] = [];
    if (requiredNetworkHeader) iterateParamsParts.push(headerPart);
    if (pathParams.length > 0) iterateParamsParts.push(`path: { ${pathParams.map((p) => p.name).join(", ")} }`);
    iterateParamsParts.push("query: { ...query, nextPageToken }");
    const iterateDoc = opDoc(op, " — iterates every item across all pages.");
    const itemType =
      entities?.get(entityBase(pagination.itemsKey))?.name ??
      `NonNullable<${responseType}["${pagination.itemsKey}"]>[number]`;
    methods.push({
      name: iterateName,
      usesPaginate: true,
      usesUnwrapProp: false,
      code:
        iterateDoc +
        `${iterateName}(${iterateArgs.join(", ")}): AsyncGenerator<${itemType}, void, undefined> {\n` +
        `  return paginate(\n` +
        `    async (nextPageToken: string | undefined) =>\n` +
        `      unwrap(await client.${method.toUpperCase()}("${path}", { params: { ${iterateParamsParts.join(", ")} }, signal: options?.signal }), "${opLabel}"),\n` +
        `    "${pagination.itemsKey}",\n` +
        `  );\n` +
        `},`,
    });
  }

  return methods;
}

const METHOD_ORDER = ["list", "iterate", "get", "create", "update", "delete"];

function methodSortKey(name: string): string {
  const index = METHOD_ORDER.indexOf(name);
  return index === -1 ? `1_${name}` : `0_${index}`;
}

function renderNode(node: TreeNode, indent: string): string {
  const lines: string[] = [];
  const sortedMethods = [...node.methods].sort((a, b) => methodSortKey(a.name).localeCompare(methodSortKey(b.name)));
  for (const method of sortedMethods) {
    lines.push(...method.code.split("\n").map((line) => (line ? indent + line : line)));
  }
  for (const [childName, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${indent}${childName}: {`);
    lines.push(renderNode(child, indent + "  "));
    lines.push(`${indent}},`);
  }
  return lines.join("\n");
}

function nodeUses(node: TreeNode, flag: "usesPaginate" | "usesUnwrapProp"): boolean {
  return node.methods.some((m) => m[flag]) || [...node.children.values()].some((child) => nodeUses(child, flag));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Pass 1: analyze every operation and collect entity candidates.
interface OpRecord {
  analyzed: AnalyzedOp;
  name: string;
  node: TreeNode;
}

let operationCount = 0;
const records: OpRecord[] = [];
const entityCandidates: EntityCandidate[] = [];

for (const path of specPaths) {
  for (const method of HTTP_METHODS) {
    const op = spec.paths[path][method];
    if (!op) continue;
    operationCount += 1;
    const analyzed = analyze(path, method, op);
    const node = nodeFor(analyzed.namespace);
    const name = methodName(analyzed);
    records.push({ analyzed, name, node });

    const responseType = successJsonType(op);
    const root = analyzed.namespace[0];
    if (analyzed.unwrapKey) {
      entityCandidates.push({
        node,
        root,
        namespace: analyzed.namespace,
        base: entityBase(analyzed.unwrapKey),
        expr: `NonNullable<${responseType}["${analyzed.unwrapKey}"]>${analyzed.unwrapIsArray ? "[number]" : ""}`,
        priority: methodPriority(name),
        opId: op.operationId,
      });
    }
    if (analyzed.pagination) {
      entityCandidates.push({
        node,
        root,
        namespace: analyzed.namespace,
        base: entityBase(analyzed.pagination.itemsKey),
        expr: `NonNullable<${responseType}["${analyzed.pagination.itemsKey}"]>[number]`,
        priority: methodPriority(name),
        opId: op.operationId,
      });
    }
  }
}

const entitiesByNode = resolveEntities(entityCandidates);

// Named query interfaces, one per operation with query parameters. operationIds
// are unique by spec, so the names never clash with each other; entity aliases
// are checked explicitly below.
interface QueryType {
  name: string;
  decl: string;
}

const allEntityNames = new Set(
  [...entitiesByNode.values()].flatMap((entities) => [...entities.values()].map((entity) => entity.name)),
);
const queryTypesByOp = new Map<string, QueryType>();
const queryTypesByRoot = new Map<string, QueryType[]>();

for (const { analyzed, name } of records) {
  if (analyzed.queryParams.length === 0) continue;
  const fields: string[] = [];
  let convertible = true;
  for (const param of analyzed.queryParams) {
    const type = queryParamType(param.schema);
    if (!type) {
      warnings.push(`${analyzed.op.operationId}: query param ${param.name} has an unsupported schema, named query type skipped`);
      convertible = false;
      break;
    }
    const docLines: string[] = [];
    // The spec never sets deprecated: true on parameters; deprecations are
    // prose ("Deprecated. Use customerRef instead. ..."), so detect the prefix
    // and turn it into a real @deprecated tag for IDE strikethrough.
    let description = param.description ? cleanDescription(param.description) : "";
    const proseDeprecated = /^Deprecated[.:]\s*/i.exec(description);
    if (proseDeprecated) description = description.slice(proseDeprecated[0].length);
    if (param.deprecated || proseDeprecated) {
      docLines.push(`@deprecated ${description || "Marked as deprecated in the OpenAPI spec."}`);
    } else if (description) {
      docLines.push(description);
    }
    fields.push(
      indentBlock(docComment(docLines), "  ") + `  ${quoteKey(param.name)}${param.required ? "" : "?"}: ${type};`,
    );
  }
  if (!convertible) continue;

  const typeName = upperFirst(analyzed.op.operationId) + "Query";
  if (allEntityNames.has(typeName)) {
    console.error(`Query type ${typeName} clashes with an entity alias.`);
    process.exit(1);
  }
  const methodPath = ["sb", ...analyzed.namespace, name].join(".");
  const queryType: QueryType = {
    name: typeName,
    decl: `/** Query parameters for \`${methodPath}()\`. */\nexport interface ${typeName} {\n${fields.join("\n")}\n}\n`,
  };
  queryTypesByOp.set(analyzed.op.operationId, queryType);
  const root = analyzed.namespace[0];
  const group = queryTypesByRoot.get(root) ?? [];
  group.push(queryType);
  queryTypesByRoot.set(root, group);
}

// Pass 2: emit methods with entity aliases resolved.
for (const { analyzed, name, node } of records) {
  for (const emitted of emitMethod(analyzed, name, entitiesByNode.get(node), queryTypesByOp.get(analyzed.op.operationId)?.name)) {
    const clash = node.methods.find((m) => m.name === emitted.name);
    if (clash) {
      console.error(`Name clash in ${analyzed.namespace.join(".")}: ${emitted.name} (${analyzed.op.operationId})`);
      process.exit(1);
    }
    node.methods.push(emitted);
  }
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const HEADER = `// AUTO-GENERATED by codegen/generate-facade.ts — DO NOT EDIT.\n// Regenerate with \`npm run generate:facade\`.\n`;

const allEntities = [...entitiesByNode.values()].flatMap((entities) => [...entities.values()]);
const entitiesByRoot = new Map<string, Entity[]>();
for (const entity of allEntities) {
  const group = entitiesByRoot.get(entity.root) ?? [];
  group.push(entity);
  entitiesByRoot.set(entity.root, group);
}

const rootNames = [...roots.keys()].sort();
for (const rootName of rootNames) {
  const node = roots.get(rootName)!;
  const factory = `create${pascalCase(rootName)}`;
  const coreImports = [
    ...(nodeUses(node, "usesPaginate") ? ["paginate"] : []),
    "unwrap",
    ...(nodeUses(node, "usesUnwrapProp") ? ["unwrapProp"] : []),
    "type SpacebringDefaults",
    "type SpacebringRequestOptions",
  ].join(", ");
  const entityDefs = (entitiesByRoot.get(rootName) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (entity) =>
        `/** A ${entity.name} entity as returned by the Spacebring API. */\n` +
        `export type ${entity.name} = ${entity.expr};\n`,
    )
    .join("\n");
  const queryDefs = (queryTypesByRoot.get(rootName) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((query) => query.decl)
    .join("\n");
  const body =
    (entityDefs ? entityDefs + "\n" : "") +
    (queryDefs ? queryDefs + "\n" : "") +
    `export function ${factory}(client: Client<paths>, defaults: SpacebringDefaults) {\n` +
    `  return {\n` +
    renderNode(node, "    ") +
    `\n  };\n}\n`;
  // With named query types some files no longer reference operations[...] at all.
  const schemaImports = body.includes("operations[") ? "operations, paths" : "paths";
  const source =
    HEADER +
    `import type { Client } from "openapi-fetch";\n` +
    `import { ${coreImports} } from "../../core.js";\n` +
    `import type { ${schemaImports} } from "../schema.js";\n\n` +
    body;
  writeFileSync(join(OUT_DIR, `${rootName}.ts`), source);
}

const indexSource =
  HEADER +
  `import type { Client } from "openapi-fetch";\n` +
  `import type { SpacebringDefaults } from "../../core.js";\n` +
  `import type { paths } from "../schema.js";\n` +
  rootNames.map((name) => `import { create${pascalCase(name)} as ${name}Group } from "./${name}.js";\n`).join("") +
  `\nexport function createResources(client: Client<paths>, defaults: SpacebringDefaults) {\n` +
  `  return {\n` +
  rootNames.map((name) => `    ${name}: ${name}Group(client, defaults),\n`).join("") +
  `  };\n}\n\n` +
  `export type SpacebringResources = ReturnType<typeof createResources>;\n`;
writeFileSync(join(OUT_DIR, "index.ts"), indexSource);

// Named entity aliases and query interfaces re-exported for consumers
// (import type { Booking, GetBookingsQuery } ...).
const entitiesSource =
  HEADER +
  rootNames
    .map((name) => {
      const names = [
        ...(entitiesByRoot.get(name) ?? []).map((entity) => entity.name),
        ...(queryTypesByRoot.get(name) ?? []).map((query) => query.name),
      ]
        .sort()
        .join(", ");
      return names ? `export type { ${names} } from "./resources/${name}.js";\n` : "";
    })
    .join("");
writeFileSync(join(ROOT, "src", "generated", "entities.ts"), entitiesSource);

// Keep the coverage numbers in the README in sync with the spec.
const README_PATH = join(ROOT, "README.md");
const readme = readFileSync(README_PATH, "utf8");
const coverage = `<!-- coverage -->${operationCount} operations across ${rootNames.length} resource groups<!-- /coverage -->`;
const updatedReadme = readme.replace(/<!-- coverage -->.*?<!-- \/coverage -->/s, coverage);
if (!updatedReadme.includes(coverage)) {
  console.error("README.md is missing the <!-- coverage --> markers; coverage numbers not updated.");
  process.exit(1);
}
if (updatedReadme !== readme) writeFileSync(README_PATH, updatedReadme);

console.log(`Generated ${rootNames.length} resource files covering ${operationCount} operations.`);
if (warnings.length > 0) {
  console.warn(`\n${warnings.length} warning(s):`);
  for (const warning of warnings) console.warn(`  - ${warning}`);
}
