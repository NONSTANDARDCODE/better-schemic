/**
 * Database functions — `client.fn.call<R>(name, args)` for any `fn::…`, plus a TYPED shortcut per
 * `defineFunction` entry in the schema (`client.fn.customerTier({ total })`).
 *
 * The typed shortcut takes a NAMED object (not positional args): the schema declares the argument
 * names, so `{ total }` autocompletes, renames safely and cannot be passed out of order. The runtime
 * lowers it to the positional call the server expects (`fn::customer_tier($p0, …)`).
 */
import type { App, FunctionDef } from "../../pure";
import type { Surql } from "../../frag";
import type {
  AnyFunctionDef,
  EntriesOf,
  FunctionKeys,
  SchemaInput,
} from "./schema";

/** The decoded args of a `defineFunction` entry, by argument name. */
export type FnArgs<F> =
  F extends FunctionDef<infer A, infer _R>
    ? { [K in keyof A]: App<A[K]> }
    : never;

/** The declared return type of a `defineFunction` entry (`unknown` when `.returns()` was omitted). */
export type FnReturn<F> =
  F extends FunctionDef<infer _A, infer R> ? R : unknown;

/** A typed shortcut: zero-arg functions take no argument object. */
export type FnMethod<F> =
  FnArgs<F> extends Record<string, never>
    ? (args?: FnArgs<F>) => Promise<FnReturn<F>>
    : (args: FnArgs<F>) => Promise<FnReturn<F>>;

/** Dynamic call for any function (`fn::` prefix optional; a bare name resolves under `fn::`). */
export type FnCall = <R = unknown>(
  name: string,
  args?: readonly unknown[],
) => Promise<R>;

/**
 * The FRAGMENT form of a function: the same call, lowered to a `surql` expression instead of a
 * round-trip, so it composes anywhere a value fits (`where`, `select`, `orderBy`, another `data`).
 * This is what makes a repo's own `fn::…` (or `search::…`) usable inside a typed read instead of a
 * hand-written `$query`.
 */
export type FnFragment<F> = FnArgs<F> extends Record<string, never>
  ? () => Surql
  : (args: { [K in keyof FnArgs<F>]: FnArgInput<FnArgs<F>[K]> }) => Surql;

/** A fragment argument: the app value, a `surql` fragment, or the `RecordId` form of a link. */
type FnArgInput<T> = T | Surql | (T extends string ? string | number : never);

/** Dynamic fragment for any function (`fn::` prefix optional). */
export type FnFragmentCall = (name: string, args?: readonly unknown[]) => Surql;

/** `client.fn.expr`: the expression form — one method per schema function, zero round-trips. */
export type FnExprSurface<S = SchemaInput> = {
  readonly call: FnFragmentCall;
} & {
  readonly [K in FunctionKeys<S>]: FnFragment<
    EntriesOf<S>[K] extends AnyFunctionDef ? EntriesOf<S>[K] : AnyFunctionDef
  >;
};

/** `client.fn`: the dynamic `call` plus one typed method per schema function. */
export type FnSurface<S = SchemaInput> = {
  readonly call: FnCall;
  /** The expression form of the same catalog — usable inside a statement, not as a round-trip. */
  readonly expr: FnExprSurface<S>;
} & {
  readonly [K in FunctionKeys<S>]: FnMethod<
    EntriesOf<S>[K] extends AnyFunctionDef ? EntriesOf<S>[K] : AnyFunctionDef
  >;
};

/** The schema function defs a delegate surface narrows from (re-exported for consumers). */
export type { AnyFunctionDef };
