# `@better-schemic/surrealdb` reference cookbook

A **verified** catalog of every implemented authoring feature, paired with the exact SurrealQL DDL it
emits. Use it to look up "how do I author X, and what does it produce?" when revisiting a feature or
evolving the driver/core.

Each example is a **real, `tsc`-checked `.ts` file** under its group folder, authored with
`example(import.meta.url, { … })`:

```ts
// examples/tables/schemafull-the-default.ts
import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "SCHEMAFULL (the default)",
  note: "defineTable is SCHEMAFULL by default — fields are constrained to the declared shape.",
  ddl: `DEFINE TABLE account TYPE NORMAL SCHEMAFULL;
DEFINE FIELD name ON TABLE account TYPE string;`,
  def: defineTable("account", { id: s.string(), name: s.string() }), // real code — tsc checks it
});
```

- **`def`** — the actual authoring expression. Because it's real code (not a string), `tsc` type-checks
  every example. Authored **last** in the object.
- **`ddl`** — the exact SurrealQL it emits (the **golden**).
- **`code`** (derived) — the verbatim `def` snippet, extracted from the file's own source by the
  `example()` helper (via `import.meta.url`). This is what the website examples gallery renders.
- **`defs`** (derived) — the schema objects, straight from `def`.

`test/examples/reference.test.ts` asserts `emit(defs) === ddl` — and since `code` is extracted from the
same `def`, `code`, `defs`, and `ddl` **can never disagree**: change the emitter and the suite fails
until the reference is updated.

This is a **pure-emit** reference (no live database) — it documents authoring -> DDL. Round-trip
fidelity (apply -> introspect -> diff = 0, and `pull` regeneration) is proven separately by the live
parity suites in [`test/parity/`](../test/parity) against SurrealDB 3.1.3. See
[`docs/COVERAGE.md`](../docs/COVERAGE.md) for the full feature/status map.

## Groups

Each group is a folder of example files plus an `index.ts` that assembles them; [`index.ts`](./index.ts)
collects every group into `allGroups`.

| Group | Covers |
|---|---|
| [`tables/`](./tables) | `DEFINE TABLE` head — schema mode, type, permissions, changefeed, comment, drop, relations, views |
| [`field-types/`](./field-types) | scalars, any/null, optionality, containers, literals/unions, record links, geometry |
| [`field-clauses/`](./field-clauses) | default/value/computed/assert/`$`-constraints/string-formats/readonly/comment/flexible/permissions/reference |
| [`indexes/`](./indexes) | `DEFINE INDEX` — plain/unique/composite/count/comment/HNSW/DISKANN/FULLTEXT (+ `DEFINE ANALYZER`) |
| [`events/`](./events) | `DEFINE EVENT` — inline + standalone, WHEN/THEN |
| [`functions/`](./functions) | `DEFINE FUNCTION` — args, returns, body, permissions, comment |
| [`access/`](./access) | `DEFINE ACCESS` — RECORD/JWT/BEARER, DURATION, ON NS/DB |
| [`analyzers/`](./analyzers) | `DEFINE ANALYZER` — tokenizers + filters |
| [`escape-hatch/`](./escape-hatch) | `.$surreal(wire, codec)` for app-only types, `.$internal()` |

## Run / extend

```sh
bun test test/examples/reference.test.ts     # verify every golden still emits as documented
```

To **add** a feature: drop a new `<slug>.ts` in the relevant group folder (copy a sibling), write the
real `def`, set `ddl` to what it emits (run the test; the failure prints the actual DDL — paste it in
after eyeballing it), and add it to that group's `index.ts`. An example needing an identifier beyond the
driver API (e.g. a domain class) just declares it in the file — it's real TypeScript.

This is the reference implementation of the per-driver
[example-cookbook convention](../../core/docs/EXAMPLE-COOKBOOK-CONVENTION.md).
