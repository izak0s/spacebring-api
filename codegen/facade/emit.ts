/**
 * Emits the facade method code for one analyzed operation: the plain method
 * (unwrapped/paginated/raw return type) plus its iterate() companion when the
 * response is paginated.
 */
import type { AnalyzedOp } from "./analyze.js";
import { type Entity, entityBase } from "./entities.js";
import { type SpecOperation, type SpecParameter, TS_TYPES } from "./spec.js";
import { cleanDescription, docComment, quoteKey } from "./text.js";
import type { EmittedMethod } from "./tree.js";

interface DocParam {
  name: string;
  description: string;
  /** True when the description came from the spec (vs. a generic filler). */
  fromSpec: boolean;
}

/** DocParam for a path parameter, using the spec description when present. */
function pathDocParam(p: SpecParameter): DocParam {
  const description = p.description ? cleanDescription(p.description).replace(/\s+/g, " ") : "";
  return { name: p.name, description: description || "Path parameter.", fromSpec: description !== "" };
}

const QUERY_DOC: DocParam = { name: "query", description: "Query parameters.", fromSpec: false };
const OPTIONS_DOC: DocParam = { name: "options", description: "Request options (abort signal).", fromSpec: false };

function opDoc(op: SpecOperation, params: DocParam[], suffix = ""): string {
  const summary = op.summary ? cleanDescription(op.summary) : "";
  const description = op.description ? cleanDescription(op.description) : "";
  const lines = [summary + suffix];
  // Descriptions usually restate the summary; only keep genuinely new text.
  if (description && description !== summary && description !== `${summary}.`) lines.push(description);
  // All-or-nothing @param block (a partial one trips IDE "parameter is not
  // described" inspections), emitted only when the spec described something —
  // an all-filler block would be pure noise. One docComment entry so the tags
  // stay adjacent.
  if (params.some((p) => p.fromSpec)) {
    lines.push(params.map((p) => `@param ${p.name} ${p.description}`).join("\n * "));
  }
  if (op.deprecated) lines.push("@deprecated Marked as deprecated in the OpenAPI spec.");
  return docComment(lines);
}

function successResponseStatus(op: SpecOperation): string | undefined {
  return Object.keys(op.responses)
    .filter((status) => /^\d+$/.test(status) && Number(status) >= 200 && Number(status) < 300)
    .sort((a, b) => Number(a) - Number(b))[0];
}

export function successJsonType(op: SpecOperation): string {
  const status = successResponseStatus(op);
  if (!status) return "undefined";
  const response = op.responses[status] as { content?: Record<string, unknown> } | undefined;
  if (!response?.content?.["application/json"]) return "undefined";
  return `operations[${JSON.stringify(op.operationId)}]["responses"][${status}]["content"]["application/json"]`;
}

export function emitMethod(
  analyzed: AnalyzedOp,
  name: string,
  entities: Map<string, Entity> | undefined,
  queryTypeName: string | undefined,
  bodyTypeName: string | undefined,
): EmittedMethod[] {
  const { op, method, path, pathParams, queryParams, requiredNetworkHeader, body, pagination, unwrapKey } = analyzed;
  // Path params become TS identifiers (`id: string`, `path: { id }`) — an
  // identifier can't be string-escaped, so reject non-identifier names loudly
  // rather than emit a value a compromised spec could inject through.
  for (const p of pathParams) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.name)) {
      console.error(`${op.operationId}: path parameter "${p.name}" is not a valid identifier.`);
      process.exit(1);
    }
  }
  // Single-property bodies are unwrapped: the method takes the inner value,
  // named after the wrapper key, and the facade re-wraps it. The key becomes a
  // TS identifier, so it gets the same fail-loud guard as path params.
  const bodyKey = body?.unwrapKey;
  if (bodyKey) {
    const reserved = ["query", "options", "body", ...pathParams.map((p) => p.name)];
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(bodyKey) || reserved.includes(bodyKey)) {
      console.error(`${op.operationId}: body property "${bodyKey}" cannot be used as a parameter name.`);
      process.exit(1);
    }
  }
  // Runtime value comes from client-level config; openapi-fetch drops undefined header values.
  const headerPart = `header: { "spacebring-network-id": defaults.networkId as string }`;
  const hasQuery = queryParams.length > 0;
  const queryRequired = queryParams.some((p) => p.required);
  const opId = JSON.stringify(op.operationId);
  const queryType = queryTypeName ?? `operations[${opId}]["parameters"]["query"]`;
  const rawBodyType = `NonNullable<operations[${opId}]["requestBody"]>["content"]["application/json"]`;
  const bodyType = bodyTypeName ?? (bodyKey ? `NonNullable<${rawBodyType}[${JSON.stringify(bodyKey)}]>` : rawBodyType);

  const args: string[] = pathParams.map((p) => `${p.name}: ${TS_TYPES[p.schema?.type ?? "string"] ?? "string"}`);
  if (body) args.push(`${bodyKey ?? "body"}${body.required ? "" : "?"}: ${bodyType}`);
  if (hasQuery) args.push(`query${queryRequired ? "" : "?"}: ${queryType}`);
  args.push("options?: SpacebringRequestOptions");

  const requestParts: string[] = [];
  const paramsParts: string[] = [];
  if (requiredNetworkHeader) paramsParts.push(headerPart);
  if (pathParams.length > 0) paramsParts.push(`path: { ${pathParams.map((p) => p.name).join(", ")} }`);
  if (hasQuery) paramsParts.push("query");
  if (paramsParts.length > 0) requestParts.push(`params: { ${paramsParts.join(", ")} }`);
  // Re-wrap an unwrapped body; an omitted optional value must stay an absent
  // body (not `{}`), so the wrap is conditional there.
  if (body && bodyKey) {
    requestParts.push(body.required ? `body: { ${bodyKey} }` : `body: ${bodyKey} === undefined ? undefined : { ${bodyKey} }`);
  } else if (body) {
    requestParts.push("body");
  }
  requestParts.push("signal: options?.signal");
  const request = `{ ${requestParts.join(", ")} }`;

  const docParams = pathParams.map(pathDocParam);
  if (body) {
    docParams.push({
      name: bodyKey ?? "body",
      description: bodyKey ? `The \`${bodyKey}\` payload.` : "Request body.",
      fromSpec: false,
    });
  }
  if (hasQuery) docParams.push(QUERY_DOC);
  docParams.push(OPTIONS_DOC);
  const doc = opDoc(op, docParams);
  const responseType = successJsonType(op);
  const unwrapAlias = unwrapKey ? entities?.get(entityBase(unwrapKey))?.name : undefined;
  const rawUnwrapType = unwrapKey ? `NonNullable<${responseType}[${JSON.stringify(unwrapKey)}]>` : responseType;
  // Paginated envelopes are re-stated as a literal type using the entity alias
  // ({ bookings?: Booking[]; nextPageToken?: string }) — structurally identical
  // to the operations[...] type (typecheck enforces this), but readable on hover.
  const listAlias = !unwrapKey && pagination ? entities?.get(entityBase(pagination.itemsKey))?.name : undefined;
  const paginatedType =
    pagination && listAlias
      ? `{ ${pagination.props
          .map(
            (p) =>
              `${quoteKey(p.key)}${p.optional ? "?" : ""}: ${
                p.key === pagination.itemsKey ? `${listAlias}[]` : (p.scalar ?? `${responseType}[${JSON.stringify(p.key)}]`)
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
  const opLabelLit = JSON.stringify(opLabel);
  const pathLit = JSON.stringify(path);
  const call = `await client.${method.toUpperCase()}(${pathLit}, ${request})`;
  const methods: EmittedMethod[] = [
    {
      name,
      usesPaginate: false,
      usesUnwrapProp: unwrapKey !== undefined,
      code:
        doc +
        `async ${name}(${args.join(", ")}): Promise<${returnType}> {\n` +
        `  return ${unwrapKey ? `unwrapProp(${call}, ${JSON.stringify(unwrapKey)}, ${opLabelLit})` : `unwrap(${call}, ${opLabelLit})`};\n` +
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
    const iterateDoc = opDoc(
      op,
      [...pathParams.map(pathDocParam), QUERY_DOC, OPTIONS_DOC],
      " — iterates every item across all pages.",
    );
    const itemType =
      entities?.get(entityBase(pagination.itemsKey))?.name ??
      `NonNullable<${responseType}[${JSON.stringify(pagination.itemsKey)}]>[number]`;
    methods.push({
      name: iterateName,
      usesPaginate: true,
      usesUnwrapProp: false,
      code:
        iterateDoc +
        `${iterateName}(${iterateArgs.join(", ")}): AsyncGenerator<${itemType}, void, undefined> {\n` +
        `  return paginate(\n` +
        `    async (nextPageToken: string | undefined) =>\n` +
        `      unwrap(await client.${method.toUpperCase()}(${pathLit}, { params: { ${iterateParamsParts.join(", ")} }, signal: options?.signal }), ${opLabelLit}),\n` +
        `    ${JSON.stringify(pagination.itemsKey)},\n` +
        `  );\n` +
        `},`,
    });
  }

  return methods;
}
