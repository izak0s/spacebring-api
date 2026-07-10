/**
 * Loads spec/openapi.json and provides the shared primitives every generator
 * module needs: spec types, $ref resolution, the OpenAPI→TS scalar map, and
 * the cross-module warnings collector.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_PATH = join(ROOT, "spec", "openapi.json");

export type HttpMethod = "get" | "put" | "post" | "delete" | "patch";
export const HTTP_METHODS: HttpMethod[] = ["get", "put", "post", "delete", "patch"];

export interface SpecParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  deprecated?: boolean;
  description?: string;
  schema?: { type?: string };
}

export interface SpecOperation {
  operationId: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: SpecParameter[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
}

export interface Spec {
  paths: Record<string, Partial<Record<HttpMethod, SpecOperation>>>;
  components?: Record<string, Record<string, unknown>>;
}

export const spec: Spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
export const specPaths = Object.keys(spec.paths).sort();

/** Operations that break a generator convention; printed after generation. */
export const warnings: string[] = [];

export const TS_TYPES: Record<string, string> = { string: "string", integer: "number", number: "number", boolean: "boolean" };

export function resolveRef<T>(node: unknown): T {
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
