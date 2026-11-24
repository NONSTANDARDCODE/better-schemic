/**
 * The `DEFINE API` runtime — `client.api.get/post/put/patch/delete`.
 *
 * The SDK's `SurrealApi` binds it to the connection SESSION (there is no SurrealQL form of an API
 * call), so a `$withContext` PREFIX clone rejects these with a teaching error; use the `auth`
 * overload of `$withContext` (or `forkSession()`) for a scoped session.
 *
 * The SDK resolves an `ApiResponse` envelope for every outcome (it does not reject on 4xx/5xx), so
 * the runtime inspects `status` and throws a {@link OrmError} carrying the HTTP status and
 * the response body — a failed endpoint can never mistaks it for an empty result.
 */
import { compileError } from "./compiler/shared"
import { assertSessionBound } from "./context"
import type { DelegateContext } from "./delegate"
import { normalizeError, OrmError } from "./errors"
import { stringCoerce } from "./text"
import type { ApiBodyOptions, ApiOperations, ApiRequestOptions } from "./types/api"

const HTTP_BAD_REQUEST = 400

/** The structural slice of the SDK's `SurrealApi` the runtime drives. */
type SdkApi = {
  delete(path: string, body?: unknown): SdkApiPromise
  get(path: string): SdkApiPromise
  patch(path: string, body?: unknown): SdkApiPromise
  post(path: string, body?: unknown): SdkApiPromise
  put(path: string, body?: unknown): SdkApiPromise
}

type SdkApiPromise = {
  header(name: string, value: string): SdkApiPromise
  query(name: string, value: string): SdkApiPromise
} & Promise<SdkApiResponse>

/** The SDK's `ApiResponse` envelope. */
type SdkApiResponse = {
  body?: unknown
  headers?: Record<string, string>
  request_id?: string
  status?: number
}

/** Build `client.api` over one client context. */
export function createApiOperations(ctx: DelegateContext): ApiOperations {
  const invoke = async <T>(
    verb: "delete" | "get" | "patch" | "post" | "put",
    path: string,
    options: ApiBodyOptions | undefined,
  ): Promise<T> => {
    const operation = `api.${verb}`
    assertSessionBound(ctx.context, operation)
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw compileError(
        "ValidationError",
        `${operation}: the path must start with "/" (got ${JSON.stringify(path)}).`,
        { operation },
      )
    }
    const source = ctx.conn as unknown as { api?: (prefix?: string) => SdkApi }
    if (typeof source.api !== "function") {
      throw compileError(
        "UnsupportedCapability",
        `${operation} needs the SurrealDB SDK connection — this client wraps an object without \`api()\`.`,
        { operation },
      )
    }

    let request = verb === "get" ? source.api().get(path) : source.api()[verb](path, options?.body)

    Object.entries(options?.headers ?? {}).forEach(([name, value]) => {
      request = request.header(name, value)
    })

    Object.entries(options?.query ?? {}).forEach(([name, value]) => {
      request = request.query(name, stringCoerce(value))
    })

    let response: SdkApiResponse
    try {
      response = await request
    } catch (error) {
      throw normalizeError(error, { operation })
    }

    const status = response.status ?? 0
    if (status >= HTTP_BAD_REQUEST) {
      throw new OrmError(
        "DatabaseError",
        `${operation} "${path}" failed with status ${status}: ${describeBody(response.body)}`,
        { details: response.body, operation, status },
      )
    }
    return response.body as T
  }

  return {
    delete: <T>(path: string, options?: ApiBodyOptions) => invoke<T>("delete", path, options),
    get: <T>(path: string, options?: ApiRequestOptions) => invoke<T>("get", path, options),
    patch: <T>(path: string, options?: ApiBodyOptions) => invoke<T>("patch", path, options),
    post: <T>(path: string, options?: ApiBodyOptions) => invoke<T>("post", path, options),
    put: <T>(path: string, options?: ApiBodyOptions) => invoke<T>("put", path, options),
  }
}

/** A short rendering of an error body for the thrown message. */
function describeBody(body: unknown): string {
  if (body === undefined || body === null) return "(no body)"

  if (typeof body === "string") return body

  try {
    return JSON.stringify(body)
  } catch {
    return stringCoerce(body)
  }
}
