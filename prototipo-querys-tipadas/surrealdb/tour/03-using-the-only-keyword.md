# 3: Using the ONLY keyword

SurrealDB returns an array of results by default. But in queries that return a single record, you can add `ONLY` to return the record itself instead of the record contained inside an array.

```surql
-- Return an array with one record inside
CREATE place;
-- Return one record
CREATE ONLY place;
```

**Response**

```surql
-------- Query 1 --------
[
  {
    id: place:hke4u4eqkm9lomnma9ac
  }
]
-------- Query 2 --------
{
  id: place:8xi1lvtx785stp7lyy64
}
```

This is useful when working with the output of a query. Instead of needing to use `[0]` to pull out the first item at index 0, the output of the query itself is now just a single record.

It is also helpful when using [one of the SDKs](/docs/languages/overview) and you want a response that can be deserialised easily into a single object.
