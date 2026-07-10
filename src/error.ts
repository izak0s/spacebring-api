import type { components } from "./generated/schema.js";

export type SpacebringErrorBody = components["schemas"]["responseError"];

/**
 * Error thrown when the Spacebring API responds with a non-2xx status.
 */
export class SpacebringError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Parsed error body returned by the API, if any. */
  readonly body: SpacebringErrorBody | undefined;
  /** The operation the request targeted, e.g. `GET /billing/invoices/v1/{invoiceId}`. */
  readonly operation: string | undefined;
  /** Full URL of the failed request, if known. */
  readonly url: string | undefined;

  constructor(status: number, body?: unknown, request?: { operation?: string; url?: string }) {
    const parsed = isErrorBody(body) ? body : undefined;
    let base = parsed?.message ?? `Spacebring API request failed with status ${status}`;
    // Validation errors carry the actual problems in an (untyped) issues array;
    // surface them so the message is actionable without dumping error.body.
    const issues = parsed ? issueSummary(parsed) : undefined;
    if (issues) base += ` — ${issues}`;
    super(request?.operation ? `${base} (${request.operation})` : base);
    this.name = "SpacebringError";
    this.status = status;
    this.body = parsed;
    this.operation = request?.operation;
    this.url = request?.url;
  }
}

function isErrorBody(body: unknown): body is SpacebringErrorBody {
  return typeof body === "object" && body !== null;
}

/** Compact "path: message" list from a zod-style `issues` array, if the body has one. */
function issueSummary(body: object): string | undefined {
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const parts = issues.slice(0, 3).map((issue) => {
    if (typeof issue !== "object" || issue === null) return String(issue);
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const where = Array.isArray(path) && path.length > 0 ? path.join(".") : undefined;
    const what = typeof message === "string" ? message : JSON.stringify(issue);
    return where ? `${where}: ${what}` : what;
  });
  const more = issues.length > 3 ? `; +${issues.length - 3} more` : "";
  return parts.join("; ") + more;
}
