# Schemafull CRUD

Now that we've learned how to define both tables and fields, It's time for some schemafull CRUD.

In this lesson, we'll only cover what is different from schemaless CRUD, namely how to update the schema and data for tables and fields using:

- The `FIELD` clause on the `REMOVE` statement

- The `OVERWRITE` clause on the `DEFINE` statement

- The `ALTER` statement

## Adding and removing fields

When updating our schemaless tables, we could just `SET` or `UNSET` fields and they would appear. Not so for a `SCHEMAFULL` table, however.

```surql
UPDATE product:01FSXKCPVR8G1TVYFT4JFJS5WB
SET new_field = "why not?";
UPDATE product UNSET category;
```

In both of these cases we get a schema error. In the first case it's because the `new_field` field hasn't been defined yet, and in the second because `category` is a field that can't hold the value `NONE`, which is what `UNSET` is trying to do.

For our second `UPDATE` query which tries to `UNSET` the `category` field on our `product` table, we also get a schema error.

```surql
REMOVE FIELD category ON TABLE product;
SELECT category FROM product limit 1;
UPDATE product;
SELECT * FROM product limit 1;
```

In order to remove a field from our schemafull table, we first need to use the `REMOVE FIELD` statement.

However, that is not enough to actually remove the field data, as the `REMOVE FIELD` statement only removes the schema definition.

Once the schema definition is removed, we can use `UNSET` like we did earlier.

There is however another way, if removing multiple fields, we can simply run `UPDATE product` and the `UPDATE` statement will remove anything that is no longer a part of the schema definition.

## Updating fields and tables

For updating existing schema definitions there are two options:

- The `OVERWRITE` clause on the `DEFINE` statement

- The `ALTER` statement.

For example, we can change the datatype of a field or change a table from schemafull to schemaless.

```surql
-- Change from a generic number type to float
DEFINE FIELD OVERWRITE price ON TABLE product TYPE float;
-- Change from schemafull to schemaless
DEFINE TABLE OVERWRITE product TYPE NORMAL SCHEMALESS;
-- Change again from schemaless to schemafull
ALTER TABLE product SCHEMAFULL;
```

The difference between these two options is that

- `DEFINE ... OVERWRITE` can be used to both create new definitions and update existing ones, but needs to include the entire definition.

- The `ALTER` statement only updates existing definitions and only needs to include the items to be updated, not the entire definition.

## Summary

Let's summarise what we've learned.

When adding and removing fields:

- You need to use `DEFINE FIELD` to add the field to the schema before using `UPDATE` to add the data.

- You need to use `REMOVE FIELD` to remove the field from the schema before using `UPDATE` to remove the data.

When updating fields and tables:

- `DEFINE ... OVERWRITE` can be used to both create new definitions and update existing ones, but needs to include the entire definition.

- The `ALTER` statement only updates existing definitions and only needs to include the items to be updated, not the entire definition.

That's it for this part on making our data schemafull, in the next part, we'll explore how to make our data secure.
