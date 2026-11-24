const MAGIC_1000000 = 1_000_000
const MAGIC_1000000000 = 1_000_000_000

const MAGIC_10 = 10
const MAGIC_100 = 100
const MAGIC_1000 = 1000
const MAGIC_104 = 104
const MAGIC_105 = 105
const MAGIC_1p4 = 1.4
const MAGIC_1p4567 = 1.4567
const MAGIC_1p5 = 1.5
const MAGIC_1p6 = 1.6
const MAGIC_2 = 2
const MAGIC_3 = 3
const MAGIC_4 = 4
const MAGIC_5 = 5
const MAGIC_50 = 50
const MAGIC_51p55 = 51.55
const MAGIC_6 = 6
const MAGIC_8 = 8
const MAGIC_9 = 9
const MAGIC_m0p04 = -0.04
const MAGIC_m2 = -2
const MAGIC_m5 = -5
// Typed-fragments PHASE 3: the `surql.fn` builtin catalog. Lowering is unit-tested; the LIVE
// sweep runs EVERY catalog entry against a real server with sample args — a builtin name that
// doesn't exist on the target SurrealDB fails here, so the catalog can't drift from reality.
// Entries whose sample is `null` are syntax-verified (need capabilities/contexts a bare
// RETURN doesn't have: http, fulltext search, field contexts).
import { describe, expect, test } from "bun:test"

import { Duration, RecordId, surql } from "../../../src/surreal"
import { fn } from "../../../src/surreal/fn"

// --- walk the catalog -------------------------------------------------------------------------

type Leaf = { call: (...args: unknown[]) => { query: string }; path: string }
function leaves(node: unknown, path: string[] = []): Leaf[] {
  const out: Leaf[] = []
  if (typeof node === "function") out.push({ call: node as Leaf["call"], path: path.join(".") })
  if (node !== null && (typeof node === "object" || typeof node === "function"))
    Object.entries(node).forEach(([k, v]) => out.push(...leaves(v, [...path, k])))
  return out
}
const ALL = leaves(fn)

// --- live-sample args per catalog path (null = skip live; MUST be exhaustive) -----------------

const d = new Duration("1w")
const t = new Date("2026-01-02T03:04:05Z")
const rid = new RecordId("fnc_probe", "one")
const point = surql`(-0.04, 51.55)`
const point2 = surql`(30.46, -17.86)`

const SAMPLES: Record<string, null | unknown[]> = {
  "array.append": [[1], MAGIC_2],
  "array.at": [[1, MAGIC_2], 0],
  "array.combine": [[1], [MAGIC_2]],
  "array.complement": [[1, MAGIC_2], [MAGIC_2]],
  "array.concat": [[1], [MAGIC_2]],
  "array.difference": [
    [1, MAGIC_2],
    [MAGIC_2, MAGIC_3],
  ],
  "array.distinct": [[1, 1, MAGIC_2]],
  "array.find_index": [[1, MAGIC_2], MAGIC_2],
  "array.first": [[1, MAGIC_2]],
  "array.flatten": [[[1], [MAGIC_2]]],
  "array.group": [[[1], [1, MAGIC_2]]],
  "array.insert": [[1, MAGIC_3], MAGIC_2, 1],
  "array.intersect": [
    [1, MAGIC_2],
    [MAGIC_2, MAGIC_3],
  ],
  "array.is_empty": [[]],
  "array.join": [["a", "b"], ","],
  "array.last": [[1, MAGIC_2]],
  "array.len": [[1, MAGIC_2, MAGIC_3]],
  "array.max": [[1, MAGIC_9, MAGIC_2]],
  "array.min": [[1, MAGIC_9, MAGIC_2]],
  "array.pop": [[1, MAGIC_2]],
  "array.prepend": [[MAGIC_2], 1],
  "array.push": [[1], MAGIC_2],
  "array.range": [1, MAGIC_4],
  "array.remove": [[1, MAGIC_2, MAGIC_3], 1],
  "array.repeat": ["x", MAGIC_3],
  "array.reverse": [[1, MAGIC_2]],
  "array.shuffle": [[1, MAGIC_2, MAGIC_3]],
  "array.slice": [[1, MAGIC_2, MAGIC_3], 1, MAGIC_2],
  "array.sort.asc": [[MAGIC_3, 1, MAGIC_2]],
  "array.sort.desc": [[MAGIC_3, 1, MAGIC_2]],
  "array.union": [[1], [MAGIC_2]],
  count: [true],
  "crypto.argon2.compare": [fn.crypto.argon2.generate("pw"), "pw"],
  "crypto.argon2.generate": ["pw"],
  "crypto.bcrypt.compare": [fn.crypto.bcrypt.generate("pw"), "pw"],
  "crypto.bcrypt.generate": ["pw"],
  "crypto.md5": ["x"],
  "crypto.pbkdf2.compare": [fn.crypto.pbkdf2.generate("pw"), "pw"],
  "crypto.pbkdf2.generate": ["pw"],
  "crypto.scrypt.compare": [fn.crypto.scrypt.generate("pw"), "pw"],
  "crypto.scrypt.generate": ["pw"],
  "crypto.sha1": ["x"],
  "crypto.sha256": ["x"],
  "crypto.sha512": ["x"],
  "duration.days": [d],
  "duration.from_days": [MAGIC_2],
  "duration.from_hours": [MAGIC_2],
  "duration.from_micros": [MAGIC_2],
  "duration.from_millis": [MAGIC_2],
  "duration.from_mins": [MAGIC_2],
  "duration.from_nanos": [MAGIC_2],
  "duration.from_secs": [MAGIC_2],
  "duration.from_weeks": [MAGIC_2],
  "duration.hours": [d],
  "duration.micros": [d],
  "duration.millis": [d],
  "duration.mins": [d],
  "duration.nanos": [d],
  "duration.secs": [d],
  "duration.weeks": [d],
  "duration.years": [d],
  "encoding.base64.decode": [fn.encoding.base64.encode(new Uint8Array([MAGIC_104, MAGIC_105]))],
  "encoding.base64.encode": [new Uint8Array([MAGIC_104, MAGIC_105])],
  "geo.area": [
    surql`{ type: 'Polygon', coordinates: [[[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]]] }`,
  ],
  "geo.bearing": [point, point2],
  "geo.centroid": [
    surql`{ type: 'Polygon', coordinates: [[[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]]] }`,
  ],
  "geo.distance": [point, point2],
  "http.delete": null,
  "http.get": null,
  "http.head": null,
  "http.patch": null,
  "http.post": null,
  "http.put": null,
  "math.abs": [MAGIC_m2],
  "math.bottom": [[1, MAGIC_5, MAGIC_2], MAGIC_2],
  "math.ceil": [MAGIC_1p4],
  "math.fixed": [MAGIC_1p4567, MAGIC_2],
  "math.floor": [MAGIC_1p6],
  "math.interquartile": [[1, MAGIC_2, MAGIC_3, MAGIC_4]],
  "math.ln": [MAGIC_10],
  "math.log": [MAGIC_100, MAGIC_10],
  "math.log2": [MAGIC_8],
  "math.log10": [MAGIC_100],
  "math.max": [[1, MAGIC_9]],
  "math.mean": [[1, MAGIC_2, MAGIC_3]],
  "math.median": [[1, MAGIC_2, MAGIC_3]],
  "math.min": [[1, MAGIC_9]],
  "math.mode": [[1, 1, MAGIC_2]],
  "math.percentile": [[1, MAGIC_2, MAGIC_3, MAGIC_4], MAGIC_50],
  "math.pow": [MAGIC_2, MAGIC_10],
  "math.product": [[MAGIC_2, MAGIC_3]],
  "math.round": [MAGIC_1p5],
  "math.sign": [MAGIC_m5],
  "math.sqrt": [MAGIC_9],
  "math.stddev": [[1, MAGIC_2, MAGIC_3]],
  "math.sum": [[1, MAGIC_2, MAGIC_3]],
  "math.top": [[1, MAGIC_5, MAGIC_2], MAGIC_2],
  "math.variance": [[1, MAGIC_2, MAGIC_3]],
  "object.entries": [{ a: 1 }],
  "object.from_entries": [fn.object.entries({ a: 1 })],
  "object.keys": [{ a: 1 }],
  "object.len": [{ a: 1 }],
  "object.values": [{ a: 1 }],
  "parse.email.host": ["a@b.com"],
  "parse.email.user": ["a@b.com"],
  "parse.url.domain": ["https://example.com/x"],
  "parse.url.fragment": ["https://example.com/x#f"],
  "parse.url.host": ["https://example.com/x"],
  "parse.url.path": ["https://example.com/x"],
  "parse.url.port": ["https://example.com:8080/x"],
  "parse.url.query": ["https://example.com/x?a=1"],
  "parse.url.scheme": ["https://example.com/x"],
  rand: [],
  "rand.bool": [],
  "rand.enum": ["a", "b"],
  "rand.float": [1, MAGIC_2],
  "rand.id": [MAGIC_10],
  "rand.int": [1, MAGIC_9],
  "rand.string": [MAGIC_8],
  "rand.time": [],
  "rand.ulid": [],
  "rand.uuid": [],
  "rand.uuid.v4": [],
  "rand.uuid.v7": [],
  "record.exists": [rid],
  "record.id": [rid],
  "record.table": [rid],
  "search.highlight": null,
  "search.offsets": null,
  // `search::rrf` needs real rank lists from a fulltext/knn SELECT; the sample below is the
  // smallest shape the server accepts (two rank lists + the ranking constant k).
  "search.rrf": [
    [
      [1, MAGIC_2],
      [MAGIC_2, MAGIC_3],
    ],
    MAGIC_2,
  ],
  "search.score": null,
  "session.db": [],
  "session.id": [],
  "session.ip": [],
  "session.ns": [],
  "session.origin": [],
  "session.token": [],
  sleep: [new Duration("1ms")],
  "string.concat": ["a", "b"],
  "string.contains": ["abc", "b"],
  "string.ends_with": ["abc", "c"],
  "string.is_alpha": ["abc"],
  "string.is_alphanum": ["abc123"],
  "string.is_ascii": ["abc"],
  "string.is_datetime": ["2015-09-21 15:03:00", "%Y-%m-%d %H:%M:%S"],
  "string.is_domain": ["example.com"],
  "string.is_email": ["a@b.com"],
  "string.is_hexadecimal": ["ff00"],
  "string.is_ip": ["127.0.0.1"],
  "string.is_ipv4": ["127.0.0.1"],
  "string.is_ipv6": ["::1"],
  "string.is_latitude": ["51.5"],
  "string.is_longitude": ["-0.1"],
  "string.is_numeric": ["1234"],
  "string.is_semver": ["1.2.3"],
  "string.is_url": ["https://example.com"],
  "string.is_uuid": ["018a6680-5b34-7f00-8000-000000000000"],
  "string.join": [",", "a", "b"],
  "string.len": ["abc"],
  "string.lowercase": ["ABC"],
  "string.matches": ["abc", "a.c"],
  "string.repeat": ["ab", MAGIC_2],
  "string.replace": ["abc", "b", "x"],
  "string.reverse": ["abc"],
  "string.slice": ["abcdef", 1, MAGIC_3],
  "string.slug": ["Hello World"],
  "string.split": ["a,b", ","],
  "string.starts_with": ["abc", "a"],
  "string.trim": ["  x  "],
  "string.uppercase": ["abc"],
  "string.words": ["a b c"],
  "time.day": [t],
  "time.floor": [t, d],
  "time.format": [t, "%Y-%m-%d"],
  "time.from_micros": [MAGIC_1000000],
  "time.from_millis": [MAGIC_1000],
  "time.from_nanos": [MAGIC_1000000000],
  "time.from_secs": [1],
  "time.from_unix": [1],
  "time.group": [t, "day"],
  "time.hour": [t],
  "time.max": [[t, new Date()]],
  "time.min": [[t, new Date()]],
  "time.minute": [t],
  "time.month": [t],
  "time.nano": [t],
  "time.now": [],
  "time.round": [t, d],
  "time.second": [t],
  "time.timezone": [],
  "time.unix": [t],
  "time.wday": [t],
  "time.week": [t],
  "time.yday": [t],
  "time.year": [t],
  "type.bool": ["true"],
  "type.datetime": ["2026-01-02T03:04:05Z"],
  "type.decimal": ["1.5"],
  "type.duration": ["1h"],
  "type.field": null,
  "type.fields": null,
  "type.float": ["1.5"],
  "type.int": ["3"],
  "type.is_array": [[1]],
  "type.is_bool": [true],
  "type.is_datetime": [t],
  "type.is_decimal": [1],
  "type.is_duration": [d],
  "type.is_float": [MAGIC_1p5],
  "type.is_int": [1],
  "type.is_none": [1],
  "type.is_null": [1],
  "type.is_number": [1],
  "type.is_object": [{ a: 1 }],
  "type.is_record": [rid],
  "type.is_string": ["x"],
  "type.is_uuid": ["x"],
  "type.number": ["3"],
  "type.point": [[MAGIC_m0p04, MAGIC_51p55]],
  "type.record": ["fnc_probe:one"],
  "type.string": [MAGIC_3],
  "type.table": ["fnc_probe"],
  "type.uuid": ["018a6680-5b34-7f00-8000-000000000000"],
  "vector.add": [
    [1, MAGIC_2],
    [MAGIC_3, MAGIC_4],
  ],
  "vector.angle": [
    [1, 0],
    [0, 1],
  ],
  "vector.cross": [
    [1, 0, 0],
    [0, 1, 0],
  ],
  "vector.distance.chebyshev": [
    [1, MAGIC_2],
    [MAGIC_3, MAGIC_4],
  ],
  "vector.distance.euclidean": [
    [1, MAGIC_2],
    [MAGIC_3, MAGIC_4],
  ],
  "vector.distance.hamming": [
    [1, MAGIC_2],
    [1, MAGIC_4],
  ],
  "vector.distance.manhattan": [
    [1, MAGIC_2],
    [MAGIC_3, MAGIC_4],
  ],
  "vector.divide": [
    [MAGIC_4, MAGIC_6],
    [MAGIC_2, MAGIC_3],
  ],
  "vector.dot": [
    [1, MAGIC_2],
    [MAGIC_3, MAGIC_4],
  ],
  "vector.magnitude": [[MAGIC_3, MAGIC_4]],
  "vector.multiply": [
    [1, MAGIC_2],
    [MAGIC_3, MAGIC_4],
  ],
  "vector.normalize": [[MAGIC_3, MAGIC_4]],
  "vector.similarity.cosine": [
    [1, MAGIC_2],
    [MAGIC_3, MAGIC_4],
  ],
  "vector.similarity.jaccard": [
    [1, MAGIC_2],
    [MAGIC_2, MAGIC_3],
  ],
  "vector.similarity.pearson": [
    [1, MAGIC_2, MAGIC_3],
    [1, MAGIC_2, MAGIC_4],
  ],
  "vector.subtract": [
    [MAGIC_3, MAGIC_4],
    [1, MAGIC_2],
  ],
}

describe("catalog shape", () => {
  test("every catalog entry has a live sample (or an explicit null skip)", () => {
    const missing = ALL.filter((l) => !(l.path in SAMPLES)).map((l) => l.path)
    expect(missing).toEqual([])
    const stale = Object.keys(SAMPLES).filter((p) => !ALL.some((l) => l.path === p))
    expect(stale).toEqual([])
  })

  test("calls lower to fn(name)(args): literals bind, refs/fragments splice", () => {
    const q = fn.string.len("abc")
    expect(q.query).toMatch(/^string::len\(\$r\d+\)$/u)
    expect(Object.values(q.bindings)).toEqual(["abc"])

    const sub = surql`SELECT * FROM fnc_t WHERE string::len(name) > 1`
    const composed = fn.array.len(sub)
    expect(composed.query).toMatch(
      /^array::len\(\(SELECT \* FROM fnc_t WHERE string::len\(name\) > 1\)\)$/u,
    )
  })

  test("fn results interpolate into surql templates and builder slots", () => {
    const q = surql`RETURN ${fn.string.uppercase("hi")}`
    expect(q.query).toMatch(/^RETURN string::uppercase\(\$r\d+\)$/u)
  })
})
