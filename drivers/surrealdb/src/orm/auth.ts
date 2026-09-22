/**
 * The auth runtime — a typed passthrough over the SDK session auth (`signin`/`signup`/
 * `authenticate`/`invalidate`/`auth`).
 *
 * Session-bound: a `$withContext` prefix clone rejects these with a teaching error. Errors are
 * normalized to the structured catalog (`NotAuthenticated` for a missing/invalid session, the
 * server's code otherwise).
 */
import type { AccessRecordAuth, AnyAuth, Token, Tokens } from "surrealdb";
import { assertSessionBound } from "./context";
import type { DelegateContext } from "./delegate";
import { BetterSchemicError, normalizeError } from "./errors";
import type { AuthOperations } from "./types/auth";

/** The structural slice of the SDK session the runtime drives. */
interface SdkAuth {
  signin(auth: AnyAuth): Promise<Tokens>;
  signup(auth: AccessRecordAuth): Promise<Tokens>;
  authenticate(token: Token | Tokens): Promise<Tokens>;
  invalidate(): Promise<void>;
  auth(): Promise<{ id?: unknown } | undefined>;
}

/** Build `client.auth` over one client context. */
export function createAuthOperations(ctx: DelegateContext): AuthOperations {
  const sdk = ctx.conn as unknown as Partial<SdkAuth>;

  /** Guard (session-bound) + resolve one SDK method + normalize its failure. */
  const invoke = async <T>(
    method: keyof SdkAuth,
    operation: string,
    args: readonly unknown[],
  ): Promise<T> => {
    assertSessionBound(ctx.context, operation);
    const fn = sdk[method];
    if (typeof fn !== "function")
      throw new BetterSchemicError(
        "UnsupportedCapability",
        `${operation} needs the SurrealDB SDK connection — this client wraps an object without \`${method}()\`.`,
        { operation },
      );
    try {
      return (await (fn as (...a: unknown[]) => Promise<T>).call(
        sdk,
        ...args,
      )) as T;
    } catch (e) {
      const normalized = normalizeError(e, { operation });
      // The SDK resolves `record()` with `SELECT $auth` + ONLY: with no record user the server
      // reports an "expected a single result" internal error — that means "not a record session".
      if (
        method === "auth" &&
        /single result output when using the ONLY/i.test(normalized.message)
      )
        throw new BetterSchemicError(
          "NotAuthenticated",
          "auth.record(): this session has no authenticated RECORD user — sign in with record access (`auth.signin({ access, variables })`) first.",
          { operation, cause: e },
        );
      throw normalized;
    }
  };

  return {
    signin: (auth) => invoke("signin", "auth.signin", [auth]),
    signup: (auth) => invoke("signup", "auth.signup", [auth]),
    authenticate: (token) =>
      invoke("authenticate", "auth.authenticate", [token]),
    invalidate: () => invoke("invalidate", "auth.invalidate", []),
    record: () => invoke("auth", "auth.record", []),
  };
}
