# 6: Deleting records

None of our `place` records have any useful information, so let's delete them to get ready to finally create the one library that we need. Two things to know when using [`DELETE`](/docs/reference/query-language/statements/delete) are:

- A `DELETE` statement followed by a table name will delete *all* of the records from that table.

- When SurrealDB performs an operation, it returns the result *after* the operation. So for `DELETE`, it will return nothing (an empty array).

Here is a quick example that shows this behaviour.

```surql
CREATE some_record;
DELETE some_record;
```

**Response**

```surql
-------- Query 1 --------
[
  {
    id: some_record:wqewkk86z6qqi18yenhc
  }
]
-------- Query 2 --------
[]
```

If you want to return the state before an operation, you can add `RETURN BEFORE` to the end of a query. This is especially useful in `DELETE` statements because it shows which records were deleted.

```surql
DELETE place RETURN BEFORE;
```

**Response**

```surql
[
  {
    id: place:b53ful62pogdxvjb57sh,
    num_books: 10000,
    place_type: 'library'
  },
  {
    id: place:bx4iy7ckqzhyj5xkrba9
  },
  {
    id: place:e6uldb0aoq4jib2kfgqs,
    place_type: 'library'
  },
  {
    id: place:⟨ma_bibliothèque⟩
  },
  {
    id: place:mq62n1aic4nxpuiuss93
  },
  {
    id: place:my_library
  },
  {
    id: place:noamxxe7h1rx59403sdw
  },
  {
    id: place:p2n354tklmfpgxl3bifs
  },
  {
    id: place:⟨良い図書館⟩
  },
  {
    id: place:⟨𒂍𒁾𒁀𒀀⟩
  }
]
```

You can use a `WHERE` clause to delete records that match a certain condition, or `DELETE` on a single record ID to delete just one.

```surql
-- Delete everyone named "Bill":
-- might be zero, one, or more records
DELETE person WHERE name = "Bill";
-- Will only delete one record
DELETE person:bill;
```

You can also delete a [range](/docs/reference/query-language/language-primitives/data-types/ranges) of records.

```surql
-- Delete from person:1 up to but not including person:3
DELETE person:1..3;
-- Delete from person:1 up to and including person:3
DELETE person:1..=3;
```
