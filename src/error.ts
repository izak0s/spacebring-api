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
    const base = parsed?.message ?? `Spacebring API request failed with status ${status}`;
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