/* eslint-disable @typescript-eslint/no-deprecated -- aliases `parse`/`safeParse` são exercitados de propósito como compatibilidade legada. */
const MAGIC_2 = 2
const MAGIC_3 = 3
const MAGIC_9 = 9
import { describe, expect, test } from "bun:test"
import { DateTime, RecordId, Uuid } from "surrealdb"
import { z } from "zod"

import { s, table } from "../../../src/surreal/pure"

const UUID = "0190b6e0-1234-7890-abcd-ef0123456789"

describe("native codecs (schema-level)", () => {
  test("datetime: DateTime <-> Date", () => {
    const schema = s.datetime().schema
    const decoded = z.decode(schema, new DateTime(new Date("2020-01-01T00:00:00.000Z")))
    expect(decoded).toBeInstanceOf(Date)
    expect(decoded.toISOString()).toBe("2020-01-01T00:00:00.000Z")

    const encoded = z.encode(schema, new Date("2020-01-01T00:00:00.000Z"))
    expect(encoded).toBeInstanceOf(DateTime)
  })

  test("uuid: Uuid <-> string", () => {
    const schema = s.uuid().schema
    const decoded = z.decode(schema, new Uuid(UUID))
    expect(decoded).toBe(UUID)

    const encoded = z.encode(schema, UUID)
    expect(encoded).toBeInstanceOf(Uuid)
    expect(encoded.toString()).toBe(UUID)
  })

  test("uuid: encoding an invalid string fails", () => {
    expect(() => z.encode(s.uuid().schema, "not-a-uuid")).toThrow()
  })

  test("bytes: Uint8Array passes through, ArrayBuffer is normalized", () => {
    const schema = s.bytes().schema
    const u8 = new Uint8Array([1, MAGIC_2, MAGIC_3])
    expect(z.decode(schema, u8)).toBeInstanceOf(Uint8Array)

    const fromBuffer = z.decode(schema, u8.buffer)
    expect(fromBuffer).toBeInstanceOf(Uint8Array)
    expect([...(fromBuffer as Uint8Array)]).toEqual([1, MAGIC_2, MAGIC_3])
  })

  test("recordId is identity (no codec), but enforces the table", () => {
    const schema = s.recordId("user").schema
    const rid = new RecordId("user", "x")
    expect(schema.safeParse(rid).success).toBe(true)
    expect(schema.safeParse(new RecordId("post", "x")).success).toBe(false)
  })
})

describe("field-level codec (SField.decode / encode)", () => {
  test("datetime: decode(DateTime) -> Date, encode(Date) -> DateTime", () => {
    const f = s.datetime()
    const dt = new DateTime(new Date("2020-01-01T00:00:00.000Z"))
    const decoded = f.decode(dt)
    expect(decoded).toBeInstanceOf(Date)
    expect(decoded.toISOString()).toBe("2020-01-01T00:00:00.000Z")

    const encoded = f.encode(new Date("2020-01-01T00:00:00.000Z"))
    expect(encoded).toBeInstanceOf(DateTime)
  })

  test("uuid: decode(Uuid) -> string, encode(string) -> Uuid", () => {
    const f = s.uuid()
    expect(f.decode(new Uuid(UUID))).toBe(UUID)
    const encoded = f.encode(UUID)
    expect(encoded).toBeInstanceOf(Uuid)
    expect(encoded.toString()).toBe(UUID)
  })

  test("encode throws on an invalid value; safeEncode reports it", () => {
    expect(() => s.uuid().encode("not-a-uuid")).toThrow()
    expect(s.uuid().safeEncode("not-a-uuid").success).toBe(false)
    expect(s.uuid().safeEncode(UUID).success).toBe(true)
  })

  test("async + deprecated parse alias", async () => {
    const f = s.datetime()
    const decoded = await f.decodeAsync(new DateTime(new Date("2020-01-01T00:00:00.000Z")))
    expect(decoded).toBeInstanceOf(Date)
    expect(await f.encodeAsync(new Date())).toBeInstanceOf(DateTime)
    const safe = await f.safeEncodeAsync(new Date())
    expect(safe.success).toBe(true)
    // `parse` runs the decode direction (deprecated alias).
    expect(f.parse(new DateTime(new Date("2020-01-01T00:00:00.000Z")))).toBeInstanceOf(Date)
    expect(f.safeParse(new DateTime(new Date())).success).toBe(true)
  })
})

describe("table decode/encode", () => {
  const T = table("t", {
    data: s.bytes(),
    id: z.string(),
    tag: s.uuid(),
    when: s.datetime(),
  })

  test("decode: wire row -> app object", () => {
    const row = {
      data: new Uint8Array([MAGIC_9]).buffer,
      id: new RecordId("t", "1"),
      tag: new Uuid(UUID),
      when: new DateTime(new Date("2021-06-01T12:00:00.000Z")),
    }
    const app = T.decode(row)
    expect(app.id).toBeInstanceOf(RecordId)
    expect(app.when).toBeInstanceOf(Date)
    expect(app.tag).toBe(UUID)
    expect(app.data).toBeInstanceOf(Uint8Array)
  })

  test("encode: app object -> wire row", () => {
    const wire = T.encode({
      data: new Uint8Array([MAGIC_9]),
      id: new RecordId("t", "1"),
      tag: UUID,
      when: new Date("2021-06-01T12:00:00.000Z"),
    })
    expect(wire.when).toBeInstanceOf(DateTime)
    expect(wire.tag).toBeInstanceOf(Uuid)
  })

  test("safeDecode reports failure without throwing", () => {
    const bad = T.safeDecode({
      data: 2,
      id: new RecordId("t", "1"),
      tag: 1,
      when: "nope",
    })
    expect(bad.success).toBe(false)
  })

  test("safeEncode validates the app side", () => {
    const ok = T.safeEncode({
      data: new Uint8Array([1]),
      id: new RecordId("t", "1"),
      tag: UUID,
      when: new Date(),
    })
    expect(ok.success).toBe(true)

    const bad = T.safeEncode({
      data: new Uint8Array(),
      id: new RecordId("t", "1"),
      tag: UUID,
      // @ts-expect-error - `when` must be a Date on the app side
      when: 123,
    })
    expect(bad.success).toBe(false)
  })

  test("async variants resolve", async () => {
    const row = {
      data: new Uint8Array([1]),
      id: new RecordId("t", "1"),
      tag: new Uuid(UUID),
      when: new DateTime(new Date()),
    }
    const app = await T.decodeAsync(row)
    expect(app.when).toBeInstanceOf(Date)
    const safe = await T.safeDecodeAsync(row)
    expect(safe.success).toBe(true)

    const wire = await T.encodeAsync({
      data: new Uint8Array([1]),
      id: new RecordId("t", "1"),
      tag: UUID,
      when: new Date(),
    })
    expect(wire.when).toBeInstanceOf(DateTime)
    const safeWire = await T.safeEncodeAsync({
      data: new Uint8Array([1]),
      id: new RecordId("t", "1"),
      tag: UUID,
      when: new Date(),
    })
    expect(safeWire.success).toBe(true)
  })
})
