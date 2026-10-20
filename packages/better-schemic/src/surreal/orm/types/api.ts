/**
 * Database APIs — `client.api.get/post/put/patch/delete(path, options)` invoking a server-side
 * `DEFINE API`. The SDK returns an envelope (`{ status, body, headers, request_id }`); the ORM
 * unwraps `body` and throws a structured error when `status >= 400`, so a failed endpoint never
 * looks like a successful empty body.
 *
 * `DEFINE API` is defined per method in ONE statement:
 * `DEFINE API "/articles" FOR get THEN { RETURN { status: 200, body: (SELECT * FROM article) }; } FOR post THEN { … };`
 */
/** Query parameters / headers for an API call. */
export interface ApiRequestOptions {
  /** Query-string parameters (`?limit=10`). */
  query?: Record<string, string | number | boolean>;
  /** Request headers (merged with the API's defaults). */
  headers?: Record<string, string>;
}

/** An API call that carries a body (`post`/`put`/`patch`/`delete`). */
export interface ApiBodyOptions extends ApiRequestOptions {
  body?: unknown;
}

/** The five verbs `DEFINE API` supports. */
export interface ApiOperations {
  /** `DEFINE API … FOR get` — the decoded response body. */
  get<T = unknown>(path: string, options?: ApiRequestOptions): Promise<T>;
  post<T = unknown>(path: string, options?: ApiBodyOptions): Promise<T>;
  put<T = unknown>(path: string, options?: ApiBodyOptions): Promise<T>;
  patch<T = unknown>(path: string, options?: ApiBodyOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: ApiBodyOptions): Promise<T>;
}
