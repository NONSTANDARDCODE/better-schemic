/**
 * Core namespace bridge for generated validator code.
 *
 * Lets rewritten output keep its `import * as __zcCore from ...` shape while pointing at
 * `better-schemic/zod/core` instead of the bare `zod/v4/core` specifier.
 */
export * from "zod/v4/core"
