# Deleting data

It's time! We've created, read and updated, all that is left now in part 1 is to `DELETE`.

We'll cover:

- How to delete fields inside records

- How to delete one record, a range of records, or the entire table

We'll start where we left off in our previous lesson on deleting fields.

## Deleting fields

```surql
-- Delete sub_category for one record
UPDATE product:01FSXKCPVR8G1TVYFT4JFJS5WB
SET sub_category = NONE;
-- Delete sub_category for the entire table
UPDATE product UNSET sub_category;
```

SurrealQL does have a `REMOVE FIELD` statement, but that only works for schema definitions, as we'll explore in part 3.

For schemaless tables, we use the `UPDATE` statement to either:

- `SET` the field to NONE

- `UNSET` the field

`NONE` means something does not exist, whereas `NULL` means the field exists but it doesn't contain any data. Therefore we are using `NONE` to say that the field should not exist, or in other words, be deleted.

```surql
-- Delete sub_category for the entire table
UPDATE product MERGE {sub_category: NONE};
UPDATE product PATCH [
  {
    op: "remove",
    path: "sub_category"
  }
];
```

The reason we have this logic instead of only having `UNSET` is because `UNSET` doesn't work with the `CONTENT`, `MERGE` or `PATCH` clauses, where we need to use `NONE` or the remove operation for `PATCH`.

## Removing records

Now that we know how to delete fields, let's delete entire records.

```surql
-- Delete a single record
DELETE product:01FSXKCPVR8G1TVYFT4JFJS5WB RETURN BEFORE;
-- Delete all the records of a table
DELETE person RETURN BEFORE;
```

This is where we use the `DELETE` statement, which only deletes the data inside a table, but not the table itself, similar to `DELETE` and `TRUNCATE TABLE` in most SQL dialects.

In the statements above we added `RETURN BEFORE` because statements by default return the state *after* an operation has been performed, which in the case of `DELETE` is nothing. In this course it makes sense to show what has been deleted, so all of these statements have `RETURN BEFORE` at the end.

You can directly delete one record or the entire table. Just make sure that it is the right table. We wouldn't want to `DELETE` the `person` records if we wanted to `DELETE` the `product` records instead.

```surql
-- Delete a range of records with record IDs (recommended if possible)
DELETE product:01FZ0CR6N09V5RG9RQ9A3264GX..=01G0MW4VTG8QZR3A4BTEXHXWS7 RETURN BEFORE;
-- Delete a range of records with the where clause
DELETE product
WHERE time.created_at >= d"2022-10-19T00:01:53Z"
AND time.created_at <= d"2022-10-26T18:00:05Z"
RETURN BEFORE;
```

You can also `DELETE` a range of records, either by using record ranges or the `WHERE` clause.

Whenever you can, always use record IDs as that is the most efficient way.

## Deleting tables

```surql
REMOVE TABLE person;
REMOVE TABLE product;
```

In order to delete the table itself, and any data it might have, we use the `REMOVE TABLE` statement, which is similar to `DROP TABLE` in most SQL dialects.

## Summary

In summary, to delete a field inside a record, use the `UPDATE` statement to either:

- `SET field_name = NONE`

- `UNSET field_name`

`REMOVE FIELD` only works for schemafull tables, as we'll see in part 3.

Use the `DELETE` statement to:

- `DELETE` one record, a range of records, or the entire table data

- `DELETE` the data inside a table, but not the table itself, similar to `TRUNCATE TABLE` in most SQL dialects

Use `REMOVE TABLE` to delete the table itself and its data, similar to `DROP TABLE` in most SQL dialects.
