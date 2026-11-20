// zod-compiler integration — field unwrapping, markers and the generated module shapes.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  fieldSchemaOf,
  isFieldCompiled,
  markFieldCompiled,
} from "../../../src/aot";
import {
  type CompileTarget,
  renderBootstrapSource,
  renderSyntheticSource,
} from "../../../src/cli/compile";
import { betterSchemic } from "../../../src/plugin";
import { s, table } from "../../../src/surreal";

const Customer = table("customer", { name: s.string(), balance: s.number() });

describe("better-schemic/aot — field bridge", () => {
  test("fieldSchemaOf unwraps SField.schema and passes raw Zod through", () => {
    expect(fieldSchemaOf(Customer.fields.name)).toBe(
      Customer.fields.name.schema,
    );
    const raw = z.string();
    expect(fieldSchemaOf(raw)).toBe(raw);
  });

  test("compile marker is identity-preserving", () => {
    const schema = Customer.fields.name.schema;
    expect(isFieldCompiled(Customer.fields.name)).toBe(false);
    const marked = markFieldCompiled(Customer.fields.name);
    expect(marked).toBe(schema);
    expect(isFieldCompiled(Customer.fields.name)).toBe(true);
  });
});

const targets: CompileTarget[] = [
  {
    exportName: "Customer",
    sourceFile: "/app/db/schema.ts",
    table: "customer",
    fields: ["name", "balance"],
  },
];

describe("sc compile — generated modules", () => {
  test("synthetic module re-exports each field's Zod schema", () => {
    const src = renderSyntheticSource(
      targets,
      "/app/.better-schemic/aot/schemas.ts",
    );
    expect(src).toContain(
      'import { fieldSchemaOf } from "better-schemic/aot";',
    );
    expect(src).toContain("export const __bs_0_name = fieldSchemaOf(");
    expect(src).toContain("export const __bs_0_balance = fieldSchemaOf(");
    expect(src).toContain('from "../../db/schema.ts"');
  });

  test("bootstrap installs compiled validators then re-exports the definitions", () => {
    const src = renderBootstrapSource(
      targets,
      "/app/.better-schemic/schema.aot.ts",
      "/app/.better-schemic/aot/schemas.compiled.ts",
    );
    expect(src).toContain('import "./aot/schemas.compiled.ts";');
    expect(src).toContain('export { Customer } from "../db/schema.ts";');
  });
});

describe("better-schemic/plugin", () => {
  test("Bun adapter is created with better-schemic defaults", () => {
    const plugin = betterSchemic();
    expect(plugin).toBeDefined();
    expect(typeof plugin).toBe("object");
  });
});
