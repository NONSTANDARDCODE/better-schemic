// The IMPORT-FREE instantiation budget — a pure generic with no zod surface, so this file's program
// count is the clean end of the range (deterministic per tsgo version). Budget enforced by
// `scripts/type-bench.ts`; see docs/TYPE-PERF-TESTING.md.
import { bench } from "../../../../scripts/type-bench";

bench("recursive tuple reverse (pure, no imports)", () => {
  type Rev<T extends unknown[], A extends unknown[] = []> = T extends [
    infer H,
    ...infer R,
  ]
    ? Rev<R, [H, ...A]>
    : A;
  return {} as Rev<[1, 2, 3, 4, 5]>;
});
