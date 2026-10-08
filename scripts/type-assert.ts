/**
 * Compile-time type assertion — replaces `@ark/attest`'s `attest<Expected, Actual>()`.
 *
 * `assertType<Expected, Actual>()` fails to compile unless the two types are **mutually assignable**
 * (and `Actual` isn't `any`). That mirrors attest's compile-time gate (`actual extends expected`)
 * while also rejecting the two silent-degradation shapes an extends-only check lets through —
 * `actual = any` and `actual = never`. Presentation-only differences (a `readonly` modifier, an
 * intersection alias like `Row & { score: number }` written out longhand) compare equal — exactly as
 * they did under attest.
 *
 * The check is evaluated by each package's `typecheck` (`bun check`): no runtime, no TypeScript
 * compiler API, no separate program.
 * See `docs/TYPE-PERF-TESTING.md`.
 */
export type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * The call tuple: empty when the assertion holds, a diagnostic payload otherwise. That turns a
 * failed assertion into `Expected 1 arguments, but got 0` on the call line — the assert's own
 * `assertType<Expected, Actual>()` generics stay visible at that line for the diff.
 */
export type AssertCall<Expected, Actual> =
  IsAny<Actual> extends true
    ? [
        {
          error: "Actual resolved to any — the type under test collapsed";
          expected: Expected;
          actual: Actual;
        },
      ]
    : [Actual] extends [Expected]
      ? [Expected] extends [Actual]
        ? []
        : [
            {
              error: "Expected and Actual are not mutually assignable";
              expected: Expected;
              actual: Actual;
            },
          ]
      : [
          {
            error: "Expected and Actual are not mutually assignable";
            expected: Expected;
            actual: Actual;
          },
        ];

export function assertType<Expected, Actual>(
  ..._check: AssertCall<Expected, Actual>
): void {}
