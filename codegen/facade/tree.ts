/**
 * The namespace tree the facade is rendered from: one node per namespace
 * segment, methods attached to nodes, rendered depth-first with a stable
 * method order.
 */

export interface EmittedMethod {
  name: string;
  code: string;
  usesPaginate: boolean;
  usesUnwrapProp: boolean;
}

export interface TreeNode {
  methods: EmittedMethod[];
  children: Map<string, TreeNode>;
}

const newNode = (): TreeNode => ({ methods: [], children: new Map() });
export const roots = new Map<string, TreeNode>();

export function nodeFor(namespace: string[]): TreeNode {
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

const METHOD_ORDER = ["list", "iterate", "get", "create", "update", "delete"];

function methodSortKey(name: string): string {
  const index = METHOD_ORDER.indexOf(name);
  return index === -1 ? `1_${name}` : `0_${index}`;
}

export function renderNode(node: TreeNode, indent: string): string {
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

export function nodeUses(node: TreeNode, flag: "usesPaginate" | "usesUnwrapProp"): boolean {
  return node.methods.some((m) => m[flag]) || [...node.children.values()].some((child) => nodeUses(child, flag));
}
