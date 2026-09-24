/**
 * Authentication — `client.auth.signin/signup/authenticate/invalidate/record`, a thin typed
 * passthrough over the SDK's session auth. Tokens are kept by the SDK and reused on reconnect.
 *
 * Auth is bound to the connection SESSION: a `$withContext` PREFIX clone rejects it (the token would
 * belong to the session, not to the namespace/database context). Use the `auth` overload of
 * `$withContext` (or `forkSession()`) for an isolated session.
 */
import type { AccessRecordAuth, AnyAuth, Token, Tokens } from "surrealdb";

export interface AuthOperations {
  /** System user (root/ns/db) or record-access credentials. */
  signin(auth: AnyAuth): Promise<Tokens>;
  /** Record-access sign-up. */
  signup(auth: AccessRecordAuth): Promise<Tokens>;
  /** Adopt an existing access token (or access+refresh pair). */
  authenticate(token: Token | Tokens): Promise<Tokens>;
  /** End the session (the SDK clears the token). */
  invalidate(): Promise<void>;
  /** The record of the authenticated RECORD user (`undefined` when there is none). */
  record<T = Record<string, unknown>>(): Promise<T | undefined>;
}
