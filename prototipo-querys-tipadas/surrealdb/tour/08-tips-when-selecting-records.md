# 8: Tips when selecting records

Since we have a `place` record in the database with some fields, we can use a [`SELECT`](/docs/reference/query-language/statements/select) statement to take a look at it. `SELECT` is followed by the fields to display and ends with `FROM` and the target. In this case the target is `place`, meaning all `place` records in the database.

```surql
SELECT name, address FROM place;
```

The output is an array of the `address` and `name` fields of every `place` record in the database.

**Response**

```surql
[
  {
    address: '2025 Statement Street, Riverdale',
    name: 'Surreal Library'
  }
]
```

Instead of selecting all records from a table, you can add a `WHERE` clause to just select the ones that match a condition - or none at all, if no records match the condition.

```surql
-- Sumerian library was deleted so will return nothing
SELECT name, address FROM place WHERE name = "𒂍𒁾𒁀𒀀";
```

**Response**

```surql
[]
```

## The star operator and refining what to select

Instead of typing out each field, you can use `*` to show all of them.

```surql
SELECT * FROM place;
```

To select all fields minus a few, you can use `OMIT` after the star, followed by the unneeded field names.

```surql
-- Show every field except 'id'
SELECT * OMIT id FROM place;
```

## Using the `VALUE` and `ONLY` keywords

You can add `VALUE` right after the `SELECT` keyword if you only care about the value of a single field, and not its name.

```surql
SELECT VALUE name FROM place;
```

**Response**

```surql
[
  'Surreal Library'
]
```

The `ONLY` keyword works in other statements too, such as `SELECT`. It will always work if you give it an exact record ID, because a record ID can only refer to one record.

```surql
SELECT id FROM ONLY place:surreal_library;
```

**Response**

```surql
{
  id: place:surreal_library
}
```

However, if you follow it with just a table name, the database is no longer sure that only one record will be returned. The examples from here on add a second `place` record, a town hall, alongside the library so that the `place` table holds more than one record.

```surql
SELECT * FROM ONLY place;
```

**Response**

```surql
'Expected a single result output when using the ONLY keyword'
```

You can use the `LIMIT` keyword here to guarantee a maximum number of records returned. If it is followed by 1, the database will know that no more than a single record will be returned and the `ONLY` keyword can be used.

```surql
SELECT * FROM ONLY place LIMIT 1;
```

**Response**

```surql
{
  address: '2025 Statement Street, Riverdale',
  floors: 8,
  id: place:surreal_library,
  name: 'Surreal Library',
  place_type: 'library'
}
```

In this case, we should ensure that the single record returned is the one that we expect it to be. If we had used a random ID like `place:llsqrb50cm7rkvqli2sg` instead of `place:surreal_library`, we could use `WHERE` to make sure that 'Surreal Library' is the record returned.

```surql
SELECT * FROM ONLY place
WHERE name = 'Surreal Library'
LIMIT 1;
```

## Selecting from more than a single table name

A `SELECT` statement isn't just limited to a table's fields. You can create and name new fields as you see fit. They can be made from the values of existing fields, or just made up on the spot.

```surql
SELECT
    name,
    -- Use the data at 'name' for a new field
    name + '!!!' AS excited_name,
    -- Use the value 'true' for a new field
    true AS is_cool
FROM place;
```

**Response**

```surql
[
  {
    excited_name: 'Surreal Library!!!',
    is_cool: true,
    name: 'Surreal Library'
  }
]
```

And the target after `FROM` doesn't need to be a table name either. You can select from raw data too.

```surql
SELECT 
    name, 
    address
FROM 
    [
        { address: '10 Push to Main Street, Riverdale', name: 'Vector Park' },
        { name: 'Riverdale City Hall' }
    ];
```

Because the second object has no value for the field `address`, it will show up as `NONE`.

```surql
[
  {
    address: '10 Push to Main Street, Riverdale',
    name: 'Vector Park'
  },
  {
    address: NONE,
    name: 'Riverdale City Hall'
  }
]
```

You can even select from a combination of table name and raw data. Whatever SurrealDB sees after the `FROM` clause can be selected and used as output.

```surql
SELECT 
    name, 
    address
FROM 
    place, 
    { address: '10 Push to Main Street, Riverdale', name: 'Vector Park' }
```

**Response**

```surql
[
  {
    address: '2025 Statement Street, Riverdale',
    name: 'Surreal Library'
  },
  {
    address: '10 Push to Main Street, Riverdale',
    name: 'Vector Park'
  }
]
```
