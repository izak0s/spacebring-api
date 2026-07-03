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
}

interface EnvelopeInfo {
  pagination?: PaginationInfo;
  /** Set when the success envelope has a single property: the facade returns it directly. */
  unwrapKey?: string;
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
  const resolved = resolveRef<{ properties?: Record<string, { type?: string }> }>(schema);
  const properties = resolved.properties;
  if (!properties) return {};

  if (!properties.nextPageToken) {
    // Single-property envelope ({ subscription: {...} }, { locations: [...] }):
    // the facade returns the property directly.
    const keys = Object.keys(properties);
    return keys.length === 1 ? { unwrapKey: keys[0] } : {};
  }

  const arrayKeys = Object.keys(properties).filter((key) => properties[key].type === "array");
  if (arrayKeys.length !== 1) {
    warnings.push(`${op.operationId}: paginated response with ${arrayKeys.length} array properties, iterate() skipped`);
    return {};
  }
  return { pagination: { itemsKey: arrayKeys[0] } };
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

function emitMethod(analyzed: AnalyzedOp, name: string): EmittedMethod[] {
  const { op, method, path, pathParams, queryParams, requiredNetworkHeader, body, pagination, unwrapKey } = analyzed;
  // Runtime value comes from client-level config; openapi-fetch drops undefined header values.
  const headerPart = `header: { "spacebring-network-id": defaults.networkId as string }`;
  const hasQuery = queryParams.length > 0;
  const queryRequired = queryParams.some((p) => p.required);
  const queryType = `operations["${op.operationId}"]["parameters"]["query"]`;
  const bodyType = `NonNullable<operations["${op.operationId}"]["requestBody"]>["content"]["application/json"]`;

  const args: string[] = pathParams.map((p) => `${p.name}: ${TS_TYPES[p.schema?.type ?? "string"] ?? "string"}`);
  if (body) args.push(`body${body.required ? "" : "?"}: ${bodyType}`);
  if (hasQuery) args.push(`query${queryRequired ? "" : "?"}: ${queryType}`);

  const requestParts: string[] = [];
  const paramsParts: string[] = [];
  if (requiredNetworkHeader) paramsParts.push(headerPart);
  if (pathParams.length > 0) paramsParts.push(`path: { ${pathParams.map((p) => p.name).join(", ")} }`);
  if (hasQuery) paramsParts.push("query");
  if (paramsParts.length > 0) requestParts.push(`params: { ${paramsParts.join(", ")} }`);
  if (body) requestParts.push("body");
  const request = requestParts.length > 0 ? `{ ${requestParts.join(", ")} }` : "{}";

  const doc = opDoc(op);
  const call = `await client.${method.toUpperCase()}("${path}", ${request})`;
  const methods: EmittedMethod[] = [
    {
      name,
      usesPaginate: false,
      usesUnwrapProp: unwrapKey !== undefined,
      code:
        doc +
        `async ${name}(${args.join(", ")}) {\n` +
        `  return ${unwrapKey ? `unwrapProp(${call}, "${unwrapKey}")` : `unwrap(${call})`};\n` +
        `},`,
    },
  ];

  // list -> iterate, listItems -> iterateItems: follows nextPageToken across pages.
  if (method === "get" && pagination && name.startsWith("list")) {
    const iterateName = "iterate" + name.slice("list".length);
    const iterateArgs = [
      ...pathParams.map((p) => `${p.name}: ${TS_TYPES[p.schema?.type ?? "string"] ?? "string"}`),
      `query${queryRequired ? "" : "?"}: Omit<NonNullable<${queryType}>, "nextPageToken">`,
    ];
    const iterateParamsParts: string[] = [];
    if (requiredNetworkHeader) iterateParamsParts.push(headerPart);
    if (pathParams.length > 0) iterateParamsParts.push(`path: { ${pathParams.map((p) => p.name).join(", ")} }`);
    iterateParamsParts.push("query: { ...query, nextPageToken }");
    const iterateDoc = opDoc(op, " — iterates every item across all pages.");
    methods.push({
      name: iterateName,
      usesPaginate: true,
      usesUnwrapProp: false,
      code:
        iterateDoc +
        `${iterateName}(${iterateArgs.join(", ")}) {\n` +
        `  return paginate(\n` +
        `    async (nextPageToken: string | undefined) =>\n` +
        `      unwrap(await client.${method.toUpperCase()}("${path}", { params: { ${iterateParamsParts.join(", ")} } })),\n` +
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

let operationCount = 0;
for (const path of specPaths) {
  for (const method of HTTP_METHODS) {
    const op = spec.paths[path][method];
    if (!op) continue;
    operationCount += 1;
    const analyzed = analyze(path, method, op);
    const node = nodeFor(analyzed.namespace);
    for (const emitted of emitMethod(analyzed, methodName(analyzed))) {
      const clash = node.methods.find((m) => m.name === emitted.name);
      if (clash) {
        console.error(`Name clash in ${analyzed.namespace.join(".")}: ${emitted.name} (${op.operationId})`);
        process.exit(1);
      }
      node.methods.push(emitted);
    }
  }
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const HEADER = `// AUTO-GENERATED by codegen/generate-facade.ts — DO NOT EDIT.\n// Regenerate with \`npm run generate:facade\`.\n`;

const rootNames = [...roots.keys()].sort();
for (const rootName of rootNames) {
  const node = roots.get(rootName)!;
  const factory = `create${pascalCase(rootName)}`;
  const coreImports = [
    ...(nodeUses(node, "usesPaginate") ? ["paginate"] : []),
    "unwrap",
    ...(nodeUses(node, "usesUnwrapProp") ? ["unwrapProp"] : []),
    "type SpacebringDefaults",
  ].join(", ");
  const source =
    HEADER +
    `import type { Client } from "openapi-fetch";\n` +
    `import { ${coreImports} } from "../../core.js";\n` +
    `import type { operations, paths } from "../schema.js";\n\n` +
    `export function ${factory}(client: Client<paths>, defaults: SpacebringDefaults) {\n` +
    `  return {\n` +
    renderNode(node, "    ") +
    `\n  };\n}\n`;
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
