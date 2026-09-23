// TYPE-COMPLETENESS ASSERTIONS for core's authoring type utilities (@ark/attest `attest<E,A>()`).
// Run under node/tsx (NOT bun — see docs/TYPE-PERF-TESTING.md): `bun run --cwd packages/core test:types`.
//
// `attest<Expected, Actual>()` fails to COMPILE if Actual isn't exactly Expected, and attest also
// checks it at runtime — so a type utility that silently drifts (a wrapper it stops unwrapping, a flag
// it drops) turns red here instead of surfacing as a mystery inference bug downstream.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import type * as z from "zod";
import type { InnerOf, SchemaOf } from "../../src/authoring";
import { setupTypes, teardownTypes } from "./_setup";

// attest needs its type-checker set up once per run; `_setup.ts` memoizes it so every assert file in
// the package's single node process shares ONE TypeScript program. See docs/TYPE-PERF-TESTING.md.
before(setupTypes);
after(teardownTypes);

describe("InnerOf — the schema one wrapper down", () => {
  it("unwraps ZodOptional", () => {
    attest<z.ZodString, InnerOf<z.ZodOptional<z.ZodString>>>();
  });
  it("unwraps ZodArray to its element", () => {
    attest<z.ZodNumber, InnerOf<z.ZodArray<z.ZodNumber>>>();
  });
  it("leaves a non-wrapper schema unchanged", () => {
    attest<z.ZodString, InnerOf<z.ZodString>>();
  });
});

describe("SchemaOf — the Zod schema a field carries", () => {
  it("passes a raw Zod schema straight through", () => {
    attest<z.ZodString, SchemaOf<z.ZodString>>();
  });
});
