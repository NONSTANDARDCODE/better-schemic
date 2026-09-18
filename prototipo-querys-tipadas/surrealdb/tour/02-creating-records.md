# 2: Creating records

To create a library, we are going to need a record for it. A [`CREATE`](/docs/reference/query-language/statements/create) statement followed by a table name is all that we need to create a record.

```surql
CREATE library;
```

But since our town is going to have all sorts of places, let's choose a more general table name: `place`. We can use the `SET` keyword to give this record a field called `place_type` so that we know a bit more about it.

```surql
CREATE place SET place_type = "library";
```

**Response**

```surql
[
  {
    id: place:dg96emq8s3rkaxpdrfq9,
    place_type: 'library'
  }
]
```

Since we didn't give this `place` record an ID, SurrealDB will create a random one. [Record IDs](/docs/reference/query-language/language-primitives/data-types/record-ids) are composed of the table name, a `:` after the table name, and something else. If you don't choose an exact record ID, a random [GUID](/docs/reference/query-language/functions/database-functions/rand#randuuid) (a Globally Unique Identifier) will be added after the `:` which gives an output like `place:wrwfldojvfcyl9gbe5v3`.

But you can choose your own record ID instead, like `place:1` or `place:my_library`. Just make sure it hasn't already been used, because you can't create two records with the same ID.

```surql
-- Works fine 
CREATE place:my_library;
-- Error: already exists
CREATE place:my_library;
```

**Response**

```surql
-------- Query --------
[
  {
    id: place:my_library
  }
]
-------- Query --------
'Database record `place:my_library`
already exists'
```
