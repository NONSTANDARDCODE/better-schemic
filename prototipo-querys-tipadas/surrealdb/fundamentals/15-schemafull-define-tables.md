# Define tables, views and changefeeds

In this lesson, we'll cover:

- How to define schemaless and schemafull tables

- The different table types

- Pre-computed table views

- Change feeds

- Table permissions

## Defining schemaless tables

We'll start by defining schemaless tables, or rather exploring the schemaless tables we've already defined so far.

We'll do this with the `INFO` statement, which gives us information about things we can `DEFINE` or have already defined.

```surql
INFO FOR DB;
```

When we run the query `INFO FOR DB`, we'll see everything that can be defined at the level of the database. Right now we're just going to focus on the tables.

When looking at the results, we can see that we've defined multiple schemaless tables, even though we never ran a `DEFINE TABLE` statement before.

```surql
DEFINE TABLE IF NOT EXISTS product SCHEMALESS;
```

The reason for this is because every time we `CREATE` a table, like have done multiple times up till now, SurrealDB behind the scenes does a `DEFINE TABLE` for that table. The reasons why SurrealDB can `DEFINE` a schema for a schemaless table is because it's not just either or. You can have mixed tables where some parts are schemaless and some parts are schemafull, we'll explore this more fully in our next lesson when we look at the `DEFINE FIELD` statement in more detail.

## Defining schemafull tables

```surql
DEFINE TABLE IF NOT EXISTS product SCHEMAFULL;
```

In order to make tables schemafull, we use the `SCHEMAFULL` clause on the `DEFINE TABLE` statement. When a table is defined as schemafull, the database strictly enforces the schema we've defined. That means that a value can't be set to a field on a `SCHEMAFULL` table until it has been defined via the [`DEFINE FIELD`](/docs/reference/query-language/statements/define/field) statement.

## The different table types

```surql
DEFINE TABLE graph_only TYPE RELATION;
DEFINE TABLE no_graph   TYPE NORMAL;
DEFINE TABLE yolo       TYPE ANY;
```

SurrealDB makes a distinction between three types of tables:

- `TYPE RELATION` is used to add a constraint to the table, only allowing graph relations.

- `TYPE NORMAL` is also used to add a constraint to the table with the opposite effect, not allowing graph relations.

- `TYPE ANY` allows both graph and non-graph data.

By default, a schemaless table will be of `TYPE ANY` while a schemafull table will be of `TYPE NORMAL` unless you set the type otherwise.

```surql
DEFINE TABLE IF NOT EXISTS order
TYPE RELATION FROM person TO product;
DEFINE TABLE IF NOT EXISTS product_sku 
TYPE RELATION IN product OUT product;
```

You can add further constraints to tables which are `TYPE RELATION`, specifying which tables they are related to.

There are two ways of specifying this:

- Using `FROM .. TO`, as an example, `FROM person TO product`

- Using `IN .. OUT`, as an example, `IN product OUT product`

Defining the schema using `TYPE RELATION` is the recommended way of defining graph relations. This means that you don't have to `DEFINE` the `in` or `out` fields using the `DEFINE FIELD` statement.

## Pre-computed table views

In SurrealDB, like in other databases, you can create views. The way you create views is by using the `DEFINE TABLE` statement like you would for any other table, then adding the `AS` clause at the end with your `SELECT` query. Here's an example.

```surql
DEFINE TABLE IF NOT EXISTS avg_product_review AS
SELECT
  count() AS number_of_reviews,
  math::mean(<float> rating) AS avg_review,
  ->product.id AS product_id,
  ->product.name AS product_name
FROM review
GROUP BY product_id, product_name;
-- Query it like a regular table
SELECT * FROM avg_product_review;
```

There are a few important things which make our views far more powerful than a typical relational database view and also a few limitations to keep in mind.

We'll start with what makes them powerful. Our pre-computed table views are most similar to event-based, incrementally updating, materialised views. That was a mouthful, so let's explain what that means.

- Event-based: this means that when you add or remove data from the underlying table, in our example, the `review` table, it triggers a matching event on the `avg_product_review` table view.

- Materialised view: this means that the first time we run the table view query, it will run the query like a normal `SELECT` statement, but then materialise the result. Contrast this with normal views which behave like bookmarked `SELECT` queries and just look like tables to the user.

- Incrementally updating: this means that for any subsequent run, it will listen for the event trigger and perform the most efficient operation possible to always keep the result up to date, instead of outright running the `SELECT` statement again.

While this functionality can be replicated in many other databases, it is usually only done by expert users as it can be very complicated to set up and maintain. Therefore, the true power of our pre-computed table views is in making this advanced functionality accessible to everyone.

As mentioned though, there are a few limitations to keep in mind.

- First, while subsequent runs are very efficient, the initial run of large analytical queries can use a lot of resources, because it's just a normal `SELECT` statement. Therefore indexing and query optimisation are still very important.

- Second, while both graph relations and record links are supported, the table view update event only gets triggered based on the table we have in our `FROM` clause. In our case, just the `review` table, not the `product` we are also using in the query. Meaning that if you delete a `review` the `avg_product_review` will reflect that in near real-time. However, if you delete a `product`, it will still show up in `avg_product_review`.

- Third, view tables are read-only, so `CREATE`, `INSERT`, `UPSERT`, `UPDATE`, `DELETE`, and `RELATE` against a view are rejected because rows are computed from the source query.

`DROP` tables can also be useful in combination with our pre-computed table views or custom events, as you can do computation on a record and then drop (delete) it in near real-time. A typical use case for this would be time-series or log data, where you only care about storing the aggregate information.

```surql
DEFINE TABLE logs DROP;
```

Another method that is a bit similar to table views is an event, which is some sort of behaviour that is triggered when a record is created, updated, or deleted. We don't cover events in this course but you can read about them [in the documentation](/docs/reference/query-language/statements/define/event) or see [our other courses](/learn) to learn more.

## Changefeeds

Changefeeds can record and replay any change to the database, following the [Change Data Capture pattern](https://en.wikipedia.org/wiki/Change_data_capture). This enables SurrealDB to play a role within the wider ecosystem of enterprise, cloud, or micro-service based platforms, giving users the ability to retrieve and sync changes from SurrealDB to external systems and platforms.

Changefeeds are defined using the `CHANGEFEED` clause followed by its duration for our table. After that it will start recording changes as we do any CRUD operation like we normally would.

```surql
-- Define the changefeed and its duration
DEFINE TABLE IF NOT EXISTS product2 CHANGEFEED 1d;
LET $now = time::now();
-- Upsert a single record
UPSERT product2 SET
  colours -= "Pink",
  colours += "Bubble Gum Pink",
  time.updated_at = $now;
-- Show when the changefeed was defined
$now;
-- Replay the update to the product table
-- Can also show SINCE a certain timestamp - enter one a few seconds after the $now parameter
SHOW CHANGES FOR TABLE product2 SINCE 0 LIMIT 10;
```

An important thing to note is that even though in this example we just defined a `CHANGEFEED` on the `product` table, SurrealDB behind the scenes defines a `CHANGEFEED` on the entire database as well.

After doing some changes to the `product` table, we can replay them using the `SHOW CHANGES FOR TABLE product`. It's important to note that the `SINCE <time>` needs to be after the time the `CHANGEFEED` was defined.

Some typical use cases for Changefeeds include ingesting data into third-party systems, archiving data to object storage for backup or analysis purposes, or for real-time synchronisation with other platforms. Changefeeds are therefore a core feature for the enterprise.

## Table permissions

We'll cover authentication in more detail in part 4, we'll just briefly touch on here that you can define table-level `PERMISSIONS` using the `DEFINE TABLE` statement.

```surql
-- Specify access permissions for the order table
DEFINE TABLE IF NOT EXISTS order
  PERMISSIONS
    FOR select
      -- A user can select all their own orders
      WHERE in.email = $auth.email
    FOR create, update
      -- A user can create or update their own orders
      WHERE in.email = $auth.email
    FOR delete
      -- A user can delete their own order
      WHERE in.email = $auth.email;
-- Can also be specified all at once
DEFINE TABLE IF NOT EXISTS order
  PERMISSIONS
    FOR select, update, delete WHERE in.email = $auth.email;
```

You can see that you are able to set independent permissions for selecting, creating, updating, and deleting data. You can also however specify them all in one group.

## Summary

Let's just briefly summarise what we've learned

The `DEFINE TABLE` statement allows us to define:

- `SCHEMALESS` or `SCHEMAFULL` tables

- The three table types, `RELATION`, `NORMAL` and `ANY`

- Pre-computed table views using the `AS` clause followed by the `SELECT` statement

- Changefeeds, using the `CHANGEFEED` clause

- Table level `PERMISSIONS`, which can be done independently for each CRUD operation or all in one group.
