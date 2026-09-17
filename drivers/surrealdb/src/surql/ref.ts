/**
 * The field-ref carrier — a phantom type read by the ref consumers (`FnArg`, `CallArgValue`,
 * `block()`'s `ValueOf`/`ElemOf`) to recover the *decoded app value* a ref stands for.
 *
 * This used to live in `@better-schemic/core/query` as the neutral cross-driver contract; the
 * neutral toolkit was retired with the fluent builder (M0.5), so the carrier lives with the
 * SurrealDB refs it describes.
 *
 * A ref does: `interface SomeRef<T> extends FieldRefBase<T> { … }`. `brandRef` is the sanctioned
 * runtime bridge (the symbol is module-private, so drivers can't forge it).
 */
declare const REF_VALUE: unique symbol;

export interface FieldRefBase<T> {
  /** Phantom — the decoded app-value type this ref projects to. Never present at runtime. */
  readonly [REF_VALUE]: T;
}

/** Brand a ref implementation with the neutral {@link FieldRefBase} carrier. */
export function brandRef<I extends object, T = unknown>(
  impl: I,
): I & FieldRefBase<T> {
  return impl as I & FieldRefBase<T>;
}
