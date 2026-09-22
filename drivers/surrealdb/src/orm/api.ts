/**
 * The `DEFINE API` runtime — `client.api.get/post/put/patch/delete`.
 *
 * The SDK's `SurrealApi` is bound to the connection SESSION (there is no SurrealQL form of an API
 * call), so a `$withContext` PREFIX clone rejects these with a teaching error; use the `auth`
 * overload of `$withContext` (or `forkSession()`) for a scoped session.
 *
 * The SDK resolves an `ApiResponse` envelope for every outcome (it does not reject on 4xx/5xx), so
 * the runtime inspects `status` and throws a {@link BetterSchemicError} carrying the HTTP status and
 * the response body — a failed endpoint can never be mistaken for an empty result.
 */
import { compileError } from "./compiler/shared";
import { assertSessionBound } from "./context";
import type { DelegateContext } from "./delegate";
import { BetterSchemicError, normalizeError } from "./errors";
import type {
  ApiBodyOptions,
  ApiOperations,
  ApiRequestOptions,
} from "./types/api";

/** The structural slice of the SDK's `SurrealApi` the runtime drives. */
interface SdkApi {
  get(path: string): SdkApiPromise;
  post(path: string, body?: unknown): SdkApiPromise;
  put(path: string, body?: unknown): SdkApiPromise;
  patch(path: string, body?: unknown): SdkApiPromise;
  delete(path: string, body?: unknown): SdkApiPromise;
}

interface SdkApiPromise extends Promise<SdkApiResponse> {
  header(name: string, value: string): SdkApiPromise;
  query(name: string, value: string): SdkApiPromise;
}

/** The SDK's `ApiResponse` envelope. */
interface SdkApiResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  request_id?: string;
}

/** Build `client.api` over one client context. */
export function createApiOperations(ctx: DelegateContext): ApiOperations {
  const invoke = async <T>(
    verb: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    options: ApiBodyOptions | undefined,
  ): Promise<T> => {
    const operation = `api.${verb}`;
    assertSessionBound(ctx.context, operation);
    if (typeof path !== "string" || !path.startsWith("/"))
      throw compileError(
        "ValidationError",
        `${operation}: the path must start with "/" (got ${JSON.stringify(path)}).`,
        { operation },
      );
    const source = ctx.conn as unknown as { api?: (prefix?: string) => SdkApi };
    if (typeof source.api !== "function")
      throw compileError(
        "UnsupportedCapability",
        `${operation} needs the SurrealDB SDK connection — this client wraps an object without \`api()\`.`,
        { operation },
      );

    let request =
      verb === "get"
        ? source.api().get(path)
        : source.api()[verb](path, options?.body);
    for (const [name, value] of Object.entries(options?.headers ?? {}))
      request = request.header(name, value);
    for (const [name, value] of Object.entries(options?.query ?? {}))
      request = request.query(name, String(value));

    let response: SdkApiResponse;
    try {
      response = await request;
    } catch (e) {
      throw normalizeError(e, { operation });
    }
    const status = response?.status ?? 0;
    if (status >= 400)
      throw new BetterSchemicError(
        "DatabaseError",
        `${operation} "${path}" failed with status ${status}: ${describeBody(response.body)}`,
        { operation, status, details: response.body },
      );
    return response?.body as T;
  };

  return {
    get: <T>(path: string, options?: ApiRequestOptions) =>
      invoke<T>("get", path, options as ApiBodyOptions | undefined),
    post: <T>(path: string, options?: ApiBodyOptions) =>
      invoke<T>("post", path, options),
    put: <T>(path: string, options?: ApiBodyOptions) =>
      invoke<T>("put", path, options),
    patch: <T>(path: string, options?: ApiBodyOptions) =>
      invoke<T>("patch", path, options),
    delete: <T>(path: string, options?: ApiBodyOptions) =>
      invoke<T>("delete", path, options),
  };
}

/** A short rendering of an error body for the thrown message. */
function describeBody(body: unknown): string {
  if (body === undefined || body === null) return "(no body)";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}
