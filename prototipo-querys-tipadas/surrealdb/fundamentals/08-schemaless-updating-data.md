# Updating data

Now that we've returned from selecting things, it's time to update our knowledge of the `UPDATE` statement.

We'll cover:

- How to update one record, a range of records, or the entire table

- The five different methods for updating data

Let's start where we left off in our previous lesson on inserting data.

## Update with `INSERT`

We briefly touched on how both the `INSERT` and `UPSERT` statements both `INSERT` and `UPDATE`.

Let's expand a bit on the example of how to `UPDATE` with the `INSERT` statement before moving on to the `UPDATE` statement.

```surql
INSERT INTO product (id)
VALUES (1),(1) ON DUPLICATE KEY UPDATE colours += ['Purple'];
INSERT INTO product (id, colours) 
VALUES (2, ['Pink']), (2, ['Dark Heather Grey','Bubble Gum Pink', 'Purple'])
ON DUPLICATE KEY UPDATE colours = $input.colours;
```

We saw the first example in the previous lesson, but there is also another way to `UPDATE` data using the `$input` parameter. Here the `$input` parameter is an object that gives us access to all the fields of the record we are attempting to insert. We can therefore use the dot notation to select the sizes field that we are inserting and use that to update the sizes field that already exists.

While this is possible if you need it, the `UPDATE` statement generally has a much better developer experience for updating, as we'll see.

## The five different methods for updating data

```surql
-- Update the currency field in the entire product table
UPDATE product SET currency = "USD";
UPDATE product MERGE {currency: "USD"};
UPDATE product PATCH [{
    op: "replace",
    path: "currency",
    value: "USD"
}];
-- Update the entire product table to contain only the currency field
UPDATE product CONTENT {currency: "USD"};
-- Replace is an alias for CONTENT
UPDATE product REPLACE {currency: "USD"};
```

Here's what the five different types of `UPDATE` statements did.

We have `SET`, `MERGE` and `PATCH`, which can update individual fields in a record. Here we are updating the currency field in the entire product table.

- `SET` uses familiar SQL syntax

- `MERGE` does the same thing just using a JSON-like syntax

- `PATCH` also does the same thing, just using the [JSON Patch specification](https://jsonpatch.com/)

The [JSON Patch specification](https://jsonpatch.com/) is a proposed standard by the Internet Engineering Task Force (IETF).

The purpose is to avoid sending a whole document when only a part has changed, used in combination with the `HTTP PATCH` method. This allows for partial updates using HTTP APIs in a standards-compliant way.

Therefore we have:

- `MERGE` which sends partial documents in our own simplified way

- `PATCH` which sends partial documents in a standards-compliant way

- It is more flexible than `MERGE` but with a somewhat more complex syntax

Moving on to `CONTENT` and `REPLACE`. For the most part, `REPLACE` is just an alias for `CONTENT`. However, one difference is that you will see an error if you try to use `REPLACE` if it includes a field that is defined as read only. But if you use `CONTENT` that includes a value field that is read only, the query will still work and that part of the input will be ignored. So you can think of `REPLACE` as a stricter or slightly more aggressive form of `CONTENT`.

What they have in common, however, is that they always send the whole document. Which means it effectively replaces the `CONTENT` that was there previously.

```surql
-- Update a single record
UPDATE product:01GRTTE7DG94R864R67MGDT0QM SET
  colours -= "Pink",
  colours += "Bubble Gum Pink",
  time.updated_at = time::now();
UPDATE product:01GRTTE7DG94R864R67MGDT0QM PATCH [
  {
    op: "remove",
    path: "colours/1"
  },
  {
    op: "add",
    path: "colours",
    value: "Bubble Gum Pink"
  },
  {
    op: "replace",
    path: "time.updated_at",
    value: time::now()
  }
];
```

Let's explore another, more realistic example. Here we are updating a single record, which again, is the hoodie that we previously mentioned. We used to have this hoodie in the pink colour on our [SurrealDB.store](https://surrealdb.store/), but the manufacturer stopped using that colour, which meant we needed another pink colour, the Bubble Gum Pink.

Therefore, we need to update the product table in our fictional Surreal Deal Store to reflect that.

As we're replacing just an item in an array, we cannot use `MERGE` as it only works on entire fields, including nested fields inside objects like `time.updated_at` as long as you put the field path in quotes `“time.updated_at": time::now()`.

We are then left with `SET` and `PATCH`, where we remove the pink colour from the array, add Bubble Gum Pink and finally update the `updated_at` time. We could simplify our `PATCH` to only use two replace operations, but I separated it into `remove` and `add` just for educational purposes here.

```surql
-- Update a range of records with record IDs (recommended if possible)
UPDATE
  product:01FZ0CR6N09V5RG9RQ9A3264GX..=01G0MW4VTG8QZR3A4BTEXHXWS7
SET currency = "USD", time.updated_at = time::now();
-- Update a range of records with the where clause
UPDATE product
SET currency = "USD", time.updated_at = time::now()
WHERE time.created_at >= d"2022-10-19T00:01:53Z"
AND time.created_at <= d"2022-10-26T18:00:05Z";
```

You can also `UPDATE` a range of records, either by using record ranges or the where clause.

Whenever you can, always use specific record IDs as that is the most efficient way.

The `UPDATE` statement is also used to `DELETE` fields, but we'll cover that in the next lesson on deleting data.

## Summary

Now that we've updated our knowledge of the `UPDATE` statement, let's summarise what we've learned.

- The `UPDATE` statement

- Can update one record, a range of records, or the entire table.

- Has five different methods for updating data:

- Using `SET` for a SQL-like experience

- Using `MERGE` to merge-update only specific fields within a record like `SET`

- Using `CONTENT` or its near-alias `REPLACE` to completely replace the record data

- Using `PATCH` to use the JSON patch format for partial updates. Allowing for partial updates for HTTP APIs in a standards-compliant way.

1. Finally, it can also `DELETE` fields (covered in the next lesson on deleting data).
