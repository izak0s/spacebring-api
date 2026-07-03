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

  constructor(status: number, body?: unknown) {
    const parsed = isErrorBody(body) ? body : undefined;
    super(parsed?.message ?? `Spacebring API request failed with status ${status}`);
    this.name = "SpacebringError";
    this.status = status;
    this.body = parsed;
  }
}

function isErrorBody(body: unknown): body is SpacebringErrorBody {
  return typeof body === "object" && body !== null;
}
