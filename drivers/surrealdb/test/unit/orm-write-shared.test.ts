// The write-compiler shared helpers in isolation: the validation guards for data / set / unset /
// patch / arrays / strings / columns, plus the pure renderers. Direct calls keep each guard's exact
// failure code pinned (the delegate suites exercise the happy paths).
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { createBinds } from "../../src/orm/compiler/shared";
import {
  assignmentList,
  encodeData,
  isRecordColumn,
  mutationTail,
  patchOps,
  readReturn,
  recordIdText,
  requireArray,
  requireColumn,
  requireString,
  setAssignments,
  toRecord,
  unsetList,
  updatableFields,
  updateMode,
} from "../../src/orm/compiler/write-shared";
import { defineSchema } from "../../src/orm/schema";
import { fakeConn, ok } from "../orm-fixtures";
import { schema } from "./orm-writes-fixtures";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

const { conn } = fakeConn(() => [ok([])]);
const client = betterSchemic(conn, { schema });
const meta = client.$index.tables.get("users")!;

describe("encodeData", () => {
  test("requires a plain-object payload", () => {
    expect(code(() => encodeData(meta, undefined, "create", "create"))).toBe(
      "ValidationError",
    );
    expect(code(() => encodeData(meta, 5, "create", "create"))).toBe(
      "ValidationError",
    );
  });

  test("a schemaless entry passes the payload through", () => {
    const S = defineSchema({ audit: "audit_log" });
    const c = betterSchemic(fakeConn(() => [ok([])]).conn, { schema: S });
    const sm = c.$index.schemaless.get("audit")!;
    expect(encodeData(sm, { a: 1 }, "create", "create")).toEqual({ a: 1 });
  });

  test("skips undefined field values and keeps expression fields out of the codec", () => {
    const encoded = encodeData(
      meta,
      { name: "A", email: "a@x", age: undefined, active: surql`true` },
      "create",
      "create",
    ) as Record<string, unknown>;
    expect(encoded.active).toBeDefined();
    expect("age" in encoded).toBe(false);
  });
});

describe("setAssignments / assignmentList", () => {
  test("setAssignments rejects a non-object or empty payload", () => {
    const b = createBinds();
    expect(code(() => setAssignments({}, b))).toBe("ValidationError");
    expect(code(() => setAssignments(5, b))).toBe("ValidationError");
    expect(setAssignments({ name: "A" }, b)).toContain("name =");
  });

  test("assignmentList is empty for a non-object, and splices expressions", () => {
    const b = createBinds();
    expect(assignmentList(5, b)).toBe("");
    const out = assignmentList(
      { name: "A", active: surql`time::now()` },
      b,
    );
    expect(out).toContain("name =");
    expect(out).toContain("time::now()");
  });
});

describe("unsetList / patchOps", () => {
  test("unset guards: empty, non-string, unknown field; a string is accepted", () => {
    expect(code(() => unsetList([], meta, "update"))).toBe("ValidationError");
    expect(code(() => unsetList([5], meta, "update"))).toBe("ValidationError");
    expect(code(() => unsetList(["ghost"], meta, "update"))).toBe(
      "ValidationError",
    );
    expect(unsetList("name", meta, "update")).toEqual(["name"]);
    expect(unsetList(undefined, meta, "update")).toEqual([]);
  });

  test("patch guards: empty, non-object, bad op, move/copy without from, add without value", () => {
    expect(code(() => patchOps([], "patch"))).toBe("ValidationError");
    expect(code(() => patchOps([5], "patch"))).toBe("ValidationError");
    expect(code(() => patchOps([{ op: "bad", path: "/a" }], "patch"))).toBe(
      "ValidationError",
    );
    expect(code(() => patchOps([{ op: "move", path: "/a" }], "patch"))).toBe(
      "ValidationError",
    );
    expect(code(() => patchOps([{ op: "add", path: "/a" }], "patch"))).toBe(
      "ValidationError",
    );
    expect(patchOps([{ op: "remove", path: "/a" }], "patch")).toHaveLength(1);
  });
});

describe("requireArray / requireString / requireColumn", () => {
  test("non-empty array / string / known column", () => {
    expect(code(() => requireArray(5, "data", "op"))).toBe("ValidationError");
    expect(code(() => requireArray([], "data", "op"))).toBe("ValidationError");
    expect(requireArray([1], "data", "op")).toEqual([1]);

    expect(code(() => requireString(5, "id", "op"))).toBe("ValidationError");
    expect(code(() => requireString("", "id", "op"))).toBe("ValidationError");
    expect(requireString("x", "id", "op")).toBe("x");

    expect(code(() => requireColumn(meta, "ghost", "op"))).toBe(
      "ValidationError",
    );
    requireColumn(meta, "name", "op");
  });
});

describe("readReturn / updateMode / pure helpers", () => {
  test("return + mode validation", () => {
    expect(readReturn(undefined, "op", ["after"], "after")).toBe("after");
    expect(code(() => readReturn("bad", "op", ["after"], "after"))).toBe(
      "ReturnNotSupported",
    );
    expect(updateMode(undefined, "op", "merge")).toBe("merge");
    expect(code(() => updateMode("bad", "op", "merge"))).toBe(
      "ValidationError",
    );
  });

  test("recordIdText / updatableFields / mutationTail", () => {
    expect(recordIdText("user:1")).toBe("1");
    expect(recordIdText(5)).toBe("5");
    expect(recordIdText({})).toBe("[object Object]");
    expect(updatableFields({ id: 1, in: 2, out: 3, name: 4 })).toEqual(["name"]);
    expect(mutationTail("before", 5, "op")).toContain("RETURN BEFORE");
    expect(mutationTail("before", 5, "op")).toContain("TIMEOUT");
  });

  test("toRecord short-circuits an existing RecordId; schemaless meta passes", () => {
    const rid = new RecordId("user", "1");
    expect(toRecord(rid, "op")).toBe(rid);
    expect(String(toRecord("user:2", "op"))).toContain("user");
    const sm = betterSchemic(fakeConn(() => [ok([])]).conn, {
      schema: defineSchema({ audit: "audit_log" }),
    }).$index.schemaless.get("audit")!;
    requireColumn(sm, "anything", "op");
    expect(isRecordColumn(sm, "anything")).toBe(false);
  });

  test("patch guards: non-string op/path, copy, copy without from, test", () => {
    expect(code(() => patchOps([{ op: 5, path: "/a" }], "patch"))).toBe(
      "ValidationError",
    );
    expect(code(() => patchOps([{ op: "add", path: 5 }], "patch"))).toBe(
      "ValidationError",
    );
    expect(patchOps([{ op: "copy", path: "/a", from: "/b" }], "patch")).toHaveLength(
      1,
    );
    expect(code(() => patchOps([{ op: "copy", path: "/a" }], "patch"))).toBe(
      "ValidationError",
    );
    expect(patchOps([{ op: "test", path: "/a", value: 1 }], "patch")).toHaveLength(
      1,
    );
  });

  test("unset/return/mode guards take non-string and empty values", () => {
    expect(code(() => unsetList([""], meta, "update"))).toBe("ValidationError");
    expect(code(() => readReturn(5, "op", ["after"], "after"))).toBe(
      "ReturnNotSupported",
    );
    expect(code(() => updateMode(5, "op", "merge"))).toBe("ValidationError");
  });
});
