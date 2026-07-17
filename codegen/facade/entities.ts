/**
 * Named types for the public surface.
 *
 * Entity aliases: every unwrapped payload property and every paginated items
 * array yields a candidate entity type (e.g. "booking" / "bookings" ->
 * Booking). Per node the best-documented source wins (get > list > create >
 * update); names that collide across the package are disambiguated with
 * namespace qualifiers (CreditTransaction, ShopCategory). Unresolvable
 * clashes fail the build.
 *
 * Query interfaces: every operation with query parameters gets an exported
 * interface named after its operationId (getCreditsTransactions ->
 * GetCreditsTransactionsQuery), so signatures read `query?:
 * GetCreditsTransactionsQuery` instead of the operations[...] indexed-access
 * soup. The interface is rebuilt from the spec's parameter schemas; the
 * facade body still assigns it into openapi-fetch's schema-derived query
 * type, so any divergence fails the typecheck.
 */
import type { AnalyzedOp } from "./analyze.js";
import { singular } from "./naming.js";
import { resolveRef, TS_TYPES, warnings } from "./spec.js";
import { cleanDescription, docComment, indentBlock, quoteKey, upperFirst } from "./text.js";
import type { TreeNode } from "./tree.js";

// ---------------------------------------------------------------------------
// Entity aliases
// ---------------------------------------------------------------------------

export interface EntityCandidate {
  node: TreeNode;
  root: string;
  namespace: string[];
  base: string;
  /**
   * Type expression the entity alias points at: `NonNullable<components[...]>`
   * for the canonical component schema, else the operation-derived form
   * (`NonNullable<operations[...]>`, `[number]`-indexed for a list item).
   */
  expr: string;
  priority: number;
  opId: string;
}

export interface Entity {
  name: string;
  expr: string;
  root: string;
  namespace: string[];
  candidateNames: string[];
  nameIndex: number;
}

export function methodPriority(name: string): number {
  if (name === "get") return 0;
  if (name.startsWith("list") || name.startsWith("iterate")) return 1;
  if (name.startsWith("get")) return 2;
  if (name.startsWith("create")) return 3;
  if (name.startsWith("update")) return 4;
  return 5;
}

export function entityBase(key: string): string {
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

export function resolveEntities(candidates: EntityCandidate[]): Map<TreeNode, Map<string, Entity>> {
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

// ---------------------------------------------------------------------------
// Named query types
// ---------------------------------------------------------------------------

interface QuerySchema {
  type?: string;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
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

export interface QueryType {
  name: string;
  decl: string;
}

/**
 * One named query interface per operation with query parameters. operationIds
 * are unique by spec, so the names never clash with each other; entity-alias
 * clashes are checked explicitly.
 */
export function buildQueryTypes(
  records: { analyzed: AnalyzedOp; name: string }[],
  entityNames: Set<string>,
): { queryTypesByOp: Map<string, QueryType>; queryTypesByRoot: Map<string, QueryType[]> } {
  const queryTypesByOp = new Map<string, QueryType>();
  const queryTypesByRoot = new Map<string, QueryType[]>();

  for (const { analyzed, name } of records) {
    if (analyzed.queryParams.length === 0) continue;
    const fields: string[] = [];
    let convertible = true;
    for (const param of analyzed.queryParams) {
      const type = queryParamType(param.schema);
      if (!type) {
        warnings.push(
          `${analyzed.op.operationId}: query param ${param.name} has an unsupported schema, named query type skipped`,
        );
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
      fields.push(indentBlock(docComment(docLines), "  ") + `  ${quoteKey(param.name)}${param.required ? "" : "?"}: ${type};`);
    }
    if (!convertible) continue;

    const typeName = upperFirst(analyzed.op.operationId) + "Query";
    if (entityNames.has(typeName)) {
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

  return { queryTypesByOp, queryTypesByRoot };
}

// ---------------------------------------------------------------------------
// Named request-body types
// ---------------------------------------------------------------------------

export interface BodyType {
  name: string;
  decl: string;
}

/**
 * One named alias per operation with a request body, so method signatures read
 * `body: CreateSubscriptionBody` instead of the `operations[...]["requestBody"]`
 * indexed-access soup. Single-property bodies are unwrapped (the alias names
 * the inner value the method takes; the facade re-wraps it), mirroring the
 * response-envelope unwrap. Unlike query interfaces this stays an alias (not a
 * rebuilt interface): request bodies are arbitrarily nested, so re-deriving
 * them would duplicate openapi-typescript — the alias just names the schema
 * type, and the facade body assigns into it so fidelity is typecheck-enforced.
 */
export function buildBodyTypes(
  records: { analyzed: AnalyzedOp; name: string }[],
  reservedNames: Set<string>,
): { bodyTypesByOp: Map<string, BodyType>; bodyTypesByRoot: Map<string, BodyType[]> } {
  const bodyTypesByOp = new Map<string, BodyType>();
  const bodyTypesByRoot = new Map<string, BodyType[]>();

  for (const { analyzed, name } of records) {
    if (!analyzed.body) continue;
    const opId = analyzed.op.operationId;
    const typeName = `${upperFirst(opId)}Body`;
    if (reservedNames.has(typeName)) {
      console.error(`Body type ${typeName} clashes with an existing exported type.`);
      process.exit(1);
    }
    const methodPath = ["sb", ...analyzed.namespace, name].join(".");
    const raw = `NonNullable<operations["${opId}"]["requestBody"]>["content"]["application/json"]`;
    const expr = analyzed.body.unwrapKey ? `NonNullable<${raw}[${JSON.stringify(analyzed.body.unwrapKey)}]>` : raw;
    const bodyType: BodyType = {
      name: typeName,
      decl: `/** Request body for \`${methodPath}()\`. */\nexport type ${typeName} = ${expr};\n`,
    };
    bodyTypesByOp.set(opId, bodyType);
    const root = analyzed.namespace[0];
    const group = bodyTypesByRoot.get(root) ?? [];
    group.push(bodyType);
    bodyTypesByRoot.set(root, group);
  }

  return { bodyTypesByOp, bodyTypesByRoot };
}
