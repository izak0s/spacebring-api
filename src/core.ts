import { SpacebringError } from "./error.js";

/** Client-level defaults threaded into the generated facade. */
export interface SpacebringDefaults {
  /** Sent as the `spacebring-network-id` header where the API requires it. */
  networkId?: string;
}

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Unwraps an openapi-fetch result: returns `data` on success,
 * throws {@link SpacebringError} on any non-2xx response.
 */
export function unwrap<T>(result: FetchResult<T>): T {
  if (result.error !== undefined || !result.response.ok) {
    throw new SpacebringError(result.response.status, result.error);
  }
  return result.data as T;
}

/**
 * Returns the single payload property of a success envelope,
 * throwing {@link SpacebringError} when the response has no usable body.
 */
export function unwrapProp<Envelope, Key extends keyof Envelope>(
  result: FetchResult<Envelope>,
  key: Key,
): NonNullable<Envelope[Key]> {
  const value = unwrap(result)?.[key];
  if (value === undefined || value === null) {
    throw new SpacebringError(result.response.status, {
      message: `Response is missing the "${String(key)}" property`,
    });
  }
  return value as NonNullable<Envelope[Key]>;
}

/**
 * Iterates every item of a paginated list endpoint, following
 * `nextPageToken` until the last page.
 */
export async function* paginate<Page extends { nextPageToken?: string }, Key extends keyof Page>(
  fetchPage: (nextPageToken: string | undefined) => Promise<Page>,
  itemsKey: Key,
): AsyncGenerator<Page[Key] extends readonly (infer Item)[] | undefined ? Item : never, void, undefined> {
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    const items = (page[itemsKey] ?? []) as Iterable<never>;
    yield* items;
    const next = page.nextPageToken;
    if (next !== undefined && next === token) {
      throw new Error("Pagination did not advance: the API returned the same nextPageToken twice");
    }
    token = next;
  } while (token);
}
