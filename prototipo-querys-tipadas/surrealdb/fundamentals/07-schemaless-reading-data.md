# Reading data

Now that we've created some data, it's time to explore it.

In this lesson, we'll cover how to use

- The `SELECT` statement for both simple and advanced read operations, and how that compares to the `RETURN` statement.

- The `LET` statement for setting parameters to use in our statements.

- The `LIVE SELECT` statement for reading data in real-time as changes are made to the underlying table.

## Starting with the SQL select basics

Let's start with the foundations of a normal SQL `SELECT` statement.

Here are a few examples.

```surql
SELECT * FROM product;
SELECT name FROM product;
SELECT name AS product_name FROM product;
```

We can select everything from the `product` table with `SELECT * FROM product`. We can also just select specific fields by naming them, such as `SELECT name FROM product`. Finally, we can use `AS` to rename fields, such as changing `name` to `product_name`

You'll also find familiar SQL clauses such as `WHERE`, `GROUP BY`, `ORDER BY` and `LIMIT`.

### WHERE

We use the `WHERE` clause to filter for specific records, such as products which have the black pink colour.

```surql
SELECT * FROM product
WHERE "Black Pink" IN colours;
```

### GROUP BY

`GROUP BY` is usually used alongside [aggregate functions](/docs/reference/query-language/functions/database-functions#aggregate-functions), which are functions that can either be used on their own or in a statement with `GROUP BY` that aggregates data. In this example we are using it to find the number of orders and sales amount for each product.

```surql
SELECT
    product_name,
    count() AS number_of_orders,
    math::sum(price * quantity) AS sum_sales
FROM order
GROUP BY product_name;
```

A simple example to show how `GROUP BY` works is this one using the [count()](/docs/reference/query-language/functions/database-functions/count) function. Here we want to find the number of orders. It's important to be aware that when counting the number of records in a table, most relational databases don't require you to use a `GROUP BY` since the data will never be nested.

In SurrealQL however, there is a lot more flexibility to model nested data. Therefore, we can't make the same assumptions as a relational database. This means functions like `count()` always go record by record unless you specify `GROUP ALL` which will use the entire table as one group.

```surql
-- Not aggregated: returns { count: 1 } for each record
SELECT count() FROM order;
-- Aggregated: returns a single { count: 64 }
SELECT count() FROM order
GROUP ALL;
```

### ORDER BY

`ORDER BY` is used to sort the records by a certain field. By default it sorts data in ascending order, but you can also specify `DESC` for descending order.

```surql
SELECT
    product_name,
    count() AS number_of_orders
FROM order
GROUP BY product_name
ORDER BY number_of_orders DESC;
```

### LIMIT

Finally, the `LIMIT` clause is used to limit the number of records we get back from our query.

```surql
SELECT
    product_name,
    count() AS number_of_orders
FROM order
GROUP BY product_name
ORDER BY number_of_orders DESC
LIMIT 10;
```

## Moving onto more advanced features

Now that we've covered the foundations that most SQL dialects have, let's look into things specific to SurrealQL.

### Selecting a single record or a range of records

In most SQL dialects, you'd need to use the `WHERE` clause to filter by IDs or fields such as time.

```surql
SELECT name, email
FROM person
WHERE id = person:01FTP9H7BG8VDANQPN8J3Y857R;
SELECT name, email
FROM person
WHERE id >= person:01FTP9H7BG8VDANQPN8J3Y857R
AND id < person:01HG9EFC0R8DA8F87VNYP0CD8A;
```

In SurrealQL, the idiomatic way to fetch by record ID is to put the ID in the `FROM` clause rather than filtering with `WHERE`.

For a **single record**, `WHERE id = person:…` is valid SQL-style syntax and, since SurrealDB 3.0, the query planner optimises it to a direct key-value lookup, so the same path as `FROM person:…`. Even so, selecting directly by record ID is clearer and is the form we recommend.

For a **range of records**, `WHERE id >= … AND id < …` still tends to scan the table. Here you can use a [record range](/docs/reference/query-language/language-primitives/data-types/record-ids#record-ranges) in the `FROM` clause instead, because it reads only the keys in that range from the key-value store.

```surql
SELECT name, email
FROM person:01FTP9H7BG8VDANQPN8J3Y857R;
SELECT name, email
FROM person:01FTP9H7BG8VDANQPN8J3Y857R..01HG9EFC0R8DA8F87VNYP0CD8A;
```

SurrealQL also makes it easy to select what you need from a record, such as in cases where you want to select everything, but omit certain fields from a record.

```surql
-- Using omit
SELECT * OMIT time FROM person:01FTP9H7BG8VDANQPN8J3Y857R;
-- Not using omit
SELECT id, first_name, last_name, name, email, phone, address,
address_history, payment_details
FROM person:01FTP9H7BG8VDANQPN8J3Y857R;
```

### Working with objects and arrays

The `SELECT` statement in SurrealQL is extremely flexible, with many advanced features. You can find a more comprehensive list of these features in our [documentation](/docs/reference/query-language/statements/select), but for now, let's look at a few examples of how to work with objects and arrays.

For selecting and traversing objects and arrays and arrays of objects, we can use the dot and bracket notation.

```surql
-- Select the first colour in the colours array
SELECT colours[0]
FROM product:01FSXKCPVR8G1TVYFT4JFJS5WB;
-- Select updated_at from the time object
SELECT time.updated_at
FROM product:01FSXKCPVR8G1TVYFT4JFJS5WB;
-- Select the entire array of objects
SELECT images
FROM product:01FSXKCPVR8G1TVYFT4JFJS5WB;
-- Select all the URLs in the images array of objects
SELECT images.url
FROM product:01FSXKCPVR8G1TVYFT4JFJS5WB;
-- Select the first URL in the images array of objects
SELECT images[0].url
FROM product:01FSXKCPVR8G1TVYFT4JFJS5WB;
```

Here are some notes on what those queries just did.

- We can select the first colour in the colours array using `colours[0]`

- We select `updated_at` from the time object using `time.updated_at`

- To select the first URL in the images array of objects, we use a combination of both, `images[0].url`

#### Object and array functions

Object and array functions are useful for many things such as deduplicating results similar to `SELECT DISTINCT` in most SQL dialects.

```surql
-- Returns the unique items in an array
SELECT array::distinct(sub_category) AS unique_sub_cat  FROM product
GROUP ALL;
-- Flattens and returns the unique items in an array
SELECT array::group(details) AS unique_details
FROM product
GROUP ALL;
```

There are a few ways of doing this in SurrealQL:

- Using [`array::distinct()`](/docs/reference/query-language/functions/database-functions/array#arraydistinct), if the fields are not nested.

- Using [`array::flatten()`](/docs/reference/query-language/functions/database-functions/array#arrayflatten), if the fields are nested.

- Using [`array::group()`](/docs/reference/query-language/functions/database-functions/array#arraygroup), if you want to call flatten and distinct using a single method call.

Importantly, there is way to count things without using aggregate functions, if what you're counting is either an array or object. As then we can use `array::len()` or `object::len()` and get both aggregated data and non-aggregated data in one query.

```surql
-- Select the product name and the number of colours it has
SELECT
  name,
  array::len(colours) AS number_of_colours
FROM product;
-- Select the person name and the number of address fields
SELECT
  name,
  object::len(address) AS number_of_address_fields
FROM person;
```

You can find many more useful functions in our [documentation](/docs/reference/query-language/functions/database-functions).

### Tempfiles

There might be times where you want to run large analytics that have the potential to cause an out-of-memory error (OOM). That is where the `TEMPFILES` clause comes in, allowing you to process the query in temporary files on disk rather than in memory.

```surql
SELECT count() AS number_of_orders,
time::format(time.created_at, "%Y-%m") AS month,
math::sum(price * quantity) AS sum_sales, currency
FROM order
GROUP BY month, currency
ORDER BY month DESC
TEMPFILES;
```

This significantly reduces memory usage, though it's likely to also result in slower performance.

## Using `LET` parameters and subqueries

```surql
-- Find the name of the product where the price is higher than the avg price
SELECT name FROM product
WHERE [price] > (
  SELECT math::mean(price) AS avg_price FROM product GROUP ALL
  ).avg_price;
```

Subqueries function in similar ways as you'd expect from SQL dialects, such as using them in the `SELECT`, `FROM` or `WHERE` clauses. We'll cover them in more detail in part 2 on relational style joins.

```surql
-- Using the let statement to store the query result
LET $avg_price =
  SELECT VALUE math::mean(price) AS avg_price FROM ONLY product GROUP ALL;
-- Find the name of the product where the price is higher than the avg price
SELECT name from product
WHERE price > $avg_price;
```

An alternative to using subqueries is often through using common table expressions (CTEs).

SurrealQL does not use typical CTEs, but we can use the `LET` statement to cover those use cases. We can also use the `LET` statement to parameterise our queries, either directly as static values, or dynamic values in combination with the `type` functions.

```surql
LET $field_name = "name";
LET $table = "product";
LET $id = "01FSXKCPVR8G1TVYFT4JFJS5WB";
RETURN $table;
SELECT type::field($field_name)
FROM type::record($table, $id)
```

The `LET` statement can do a lot more than what we've covered here, as you can use it in almost every statement in SurrealQL and you can see more examples of that in our [documentation](/docs/reference/query-language/statements/let).

## How `SELECT` compares to `RETURN`

Aside from the `SELECT` statement, you can also use the `RETURN` statement for reading data. A `RETURN` on its own just returns the value that follows it, and technically is almost never needed. That's because the value returned from a statement is its output, whether it is preceded by `RETURN` or not.

```surql
-- Return a number
1337;
RETURN 1337; 
SELECT * FROM ONLY 1337;
```

One situation where `RETURN` does make a difference though is when you want to use it to return a value from inside a block and skip the rest.

```surql
-- Returns 1337, skips the following query
{
    RETURN 1337;
    SELECT name FROM person;
};
```

Otherwise, you still might prefer to use it for the sake of readability. Even when adding `RETURN` before a value, it ends up being shorter than the combination of `FROM ONLY` and `SELECT VALUE` using the `SELECT` statement. I'd encourage you to experiment with the queries, removing the `ONLY` and or `VALUE` clause to see how the result changes.

```surql
-- Return a record
RETURN person:01FTP9H7BG8VDANQPN8J3Y857R.*;
SELECT * FROM ONLY person:01FTP9H7BG8VDANQPN8J3Y857R;
-- Return a field value inside the record
RETURN person:01FTP9H7BG8VDANQPN8J3Y857R.name;
SELECT VALUE name FROM ONLY person:01FTP9H7BG8VDANQPN8J3Y857R;
```

You can see more examples of how to use the `RETURN` statement in code blocks, functions and transactions in our [documentation](/docs/reference/query-language/statements/return).

## Going real-time with `LIVE SELECT`

`LIVE SELECT` allows us to unlock streaming data magic, through what we call live queries.

Live queries read data in real time, as changes are made to the underlying table.

```surql
-- Start a live query
LIVE SELECT * from product;
-- Stop a live query by specifying its uuid
KILL u"57f4964c-006f-463b-a965-19a3cec330b9";
-- Start a live query using JSON patch format
LIVE SELECT DIFF from product;
```

When you run the `LIVE SELECT` in the CLI it will return a `UUID`, which is the live query unique ID. The `UUID` is used to keep track of the various live queries you have running and to stop them using the `KILL` statement.

Since SurrealDB Studio has live query listening built in, a `LIVE SELECT` will instead display the option to track the live query that you have just created.

Once you make changes to the table the live query is listening to, in our case the `product` table, you can see the live results updating.

You can either receive the changes in our normal format or use the `JSON PATCH` format by specifying `LIVE SELECT DIFF FROM product`.

You can see more details about live queries in our [documentation](/docs/reference/query-language/statements/live-select).

## Summary

Let's quickly summarise what we've learned before I see you in the next lesson.

- The `SELECT` statement

- Starts with the foundation of SQL, using familiar clauses such as `WHERE`, `GROUP BY`, `ORDER BY` and `LIMIT`.

- Has more advanced features, such as selecting directly from a record ID or a record range in the `FROM` clause - the idiomatic way to avoid table scans when fetching by ID. It can also be used to work with objects and arrays.

- Can use the `TEMPFILES` clause for processing the query in temporary files on disk rather than in memory. This is typically used for very large queries that might otherwise give an out-of-memory error (OOM).

- The `RETURN` statement

- Can `RETURN` any value, from strings and numbers to entire code blocks and query results.

- Can be used instead of the `SELECT` statement for some use cases, such as a more ergonomic way of returning values, replacing the `SELECT VALUE` and/or `FROM ONLY` from the `SELECT` statement.

- Is actually just syntactic sugar, outside of usage in code blocks, functions and transactions to return early results.

- The `LIVE SELECT` statement

- Reads data in real time as changes are made to the underlying table.

- Will return a `UUID`, which is the live query unique ID. The `UUID` is used to keep track of the various live queries you have running and to stop them using the `KILL` statement.

- Allows you to either receive the changes in our normal format or in `JSON PATCH` format by specifying `LIVE SELECT DIFF`.
