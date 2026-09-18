# Inserting data

While exploring the magic of record IDs, we used the `CREATE` statement to create tables and insert the various IDs.

However, we didn't go into what the `CREATE` statement really is or how to use it properly, so I'm sure you have questions about that.

You'll get the answers to all your questions in this lesson, but if not, let us know! We'll also cover the `INSERT` and `UPSERT` statements. We'll explore how they're different and when it makes sense to use them. That should cover everything you need to know about inserting data in a schemaless way, with the exception of relationships, which we'll cover in part 2.

Since we're covering everything you need to know, it's going to be a lot. If you want the short version (TLDR), feel free to skip the summary section.

## CREATE

As we saw in the previous lesson, `CREATE table` does indeed create a table. However, I wanted to start out with the surprise that our `CREATE` statement is for inserting data and not defining a schema, like in most SQL dialects. That is what `DEFINE TABLE` is for, as we'll see in part 3.

Now that we've cleared that up let's start by creating the `person` and `product` tables.

![](/assets/static/person-product.light.CF-zzA3F.avif)![](/assets/static/person-product.CB2mq12b.avif)

```surql
CREATE person;
CREATE product;
CREATE person, product;
```

The interesting thing about the final statement is that, though it creates both a `person` and a `product` record, it is still executed in its own transaction.

Therefore `CREATE person;` then `CREATE product;` would be two transactions, whereas `CREATE person, product;` would be one transaction.

What is a transaction

A transaction in a database is a sequence of operations performed as a single unit of work to ensure data integrity and consistency.

It adheres to the ACID properties:

- Atomicity (all operations are completed or none are)

- Consistency (transforms the database from one valid state to another)

- Isolation (concurrent transactions do not interfere with each other)

- Durability (committed changes are permanent even after a system failure)

Transactions ensure reliable and consistent data management in multi-user and distributed environments.

This is meant to give you more direct control over how your queries should behave and to reduce the need for you to use this somewhat complicated logic in your application code.

The same goes for the `TIMEOUT` clause, which can be used to specify the maximum time the statement should take to execute.

```surql
CREATE person TIMEOUT 2ms;
CREATE product TIMEOUT 2ms;
CREATE person, product TIMEOUT 3ms;
```

The `TIMEOUT` clause can be useful when you want to tightly control compute costs or make sure queries succeed or fail within tight latency boundaries. With this we avoid a big query queue forming.

Most of the time you probably don't need this though. However, it's important to know you can do this when you need to.

Now, let's finally insert more than record IDs! The `CREATE` statement has two ways of doing this.

You can use the `SET` clause like we saw earlier, which is more SQL-like. But you can also use the `CONTENT` clause which is more JSON-like.

Let's do both so we can compare like for like, starting with the `CONTENT` clause.

```surql
CREATE product CONTENT {
    name: 'Cruiser Hoodie',
    details: [ "Medium fit", "Set-in sleeve"],
    colours: ['Dark Heather Grey','Bubble Gum Pink'],
    sizes: [ "xs", "s", "m", "l", "xl"],
    price: 59,
    images: [
      {
          url: "https://surrealdb.store/cdn/shop/files/cruiser-hoodie-bubble-gum-pink-white-m-1_65f13f38-058c-4e29-b2fa-aad068da75e0.jpg",
          position: 1
      },
      {
          url: "https://surrealdb.store/cdn/shop/files/cruiser-hoodie-dark-heather-grey-pink-icon-m-1.jpg?v=1690812164",
          position: 2
      }
    ],
    time: {
        created_at: time::now(),
        updated_at: time::now()
    }
};
```

In case you're curious, the product we are creating here is an actual hoodie that you can order at our real store: [SurrealDB.store](https://surrealdb.store/).

But back to the `CONTENT`, you'll notice that this is a denormalised schema we are creating here, which means we are including all the relevant information about the product in one table.

We could normalise it by putting `details` , `colours` , `sizes` and `images` in their own tables. That way, we could have less duplication of data as many products share the same `colours` and `sizes` for example. We would however then need to join together 5 tables if we'd want the entire product information, which is massively more compute-intensive than just reading the data from one table.

Now if you're thinking, when would I ever do that? You might be surprised to hear that it's more often than you think, as you'd need all that data for every product order page.

We have however not completely denormalised it as you'll see in part 2 when we bring in the `product_sku` table, which shows how many items you have left in stock for each product sku (the combination of each colour and size).

More on that later though. Let's now show how this `CONTENT` example would look using the `SET` clause.

```surql
CREATE product SET
  name = 'Cruiser Hoodie',
  colours = ['Dark Heather Grey','Bubble Gum Pink'],
  price = 59,
  time = {
      created_at: time::now(),
      updated_at: time::now()
  };
```

You may have noticed it's not that different, mostly just replacing the `:` colon with the `=` equals sign.

You can break the object syntax down even further by specifying each field of the object separately with the dot notation.

```surql
CREATE product SET
  name = 'Cruiser Hoodie',
  time.created_at = time::now(),
  time.updated_at = time::now();
```

If you're wondering which method is better, `CONTENT` or `SET`, I would say that neither is better, it's more a matter of preference.

SurrealDB users tend to prefer `SET` when just inserting one or two fields, but `CONTENT` when inserting a lot of fields, or inserting JSON data straight from the web, or some other system where the data is in JSON format.

The most surreal thing about the `CREATE` statement however is that it's great for data generation using the pipe syntax. Here we put the pipe character on either side of the table name and specify the number of records we want to generate, as if we were creating a record ID with that number. Since we specified 100 here, we are therefore creating one hundred product records.

```surql
CREATE |product:100| CONTENT {
    name: rand::enum('Cruiser Hoodie', 'Surreal T-Shirt'),
    colours: [rand::string(10), rand::string(10)],
    price: rand::int(20, 60),
    time: {
        created_at: rand::time(1711847404, 1751847404),
        updated_at: rand::time(1751847404, 1761847404)
    }
};
```

Then instead of real data, we can use the random functions to just generate some dummy data for us. We can use `rand::string` for strings, `rand::int` for our price, `rand::time` for time and `rand::enum` for randomly selecting between the options we give it. You can find more random functions [in the documentation](/docs/reference/query-language/functions/database-functions/rand).

This is super useful for rapid prototyping of different table structures, to see what works best.

That's all we need to know for now about the `CREATE` statement, let's therefore move over to the `INSERT` statement.

## INSERT

The `INSERT` statement is more similar to what you'd expect from most SQL dialects.

You can insert a single record by using the typical tuple syntax, but with native support for arrays and objects, which is really nice.

```surql
INSERT INTO product (name, colours, price, time) VALUES
  (
    'Cruiser Hoodie',
    ['Dark Heather Grey','Bubble Gum Pink'],
    59,
    {created_at: time::now(), updated_at: time::now()}
  );
```

The same goes for inserting multiple records.

```surql
INSERT INTO product (name, colours, price, time) VALUES
  (
    'Cruiser Hoodie', 
    ['Dark Heather Grey','Bubble Gum Pink'], 
    59, 
    {
      created_at: time::now(), 
      updated_at: time::now()
    }
  ),
  (
    'Surreal T-Shirt', 
    ['White Pink','Purple White'], 
    25, 
    {
      created_at: time::now(), 
      updated_at: time::now()
    }
  );
```

Now when it comes to copying data from one table to the another table, it looks the same as in most SQL dialects. We do this by using `INSERT INTO` the `product_copy` table, inside which we put the output of selecting everything from the product table.

```surql
INSERT INTO product_copy (SELECT * FROM product);
```

There are two important things to point out here though:

- First is that our `INSERT` statement doesn't just `INSERT` data into tables you already created. It also creates a table if it doesn't already exist, exactly like we just did with the `product_copy` table (but not when using a database defined as [STRICT](/docs/reference/query-language/statements/define/database#defining-a-strict-database)).

- Second, this is currently the only way to change just the table part of your record IDs. You might need to do this for example if you accidentally used an emoji as your table name and then realised that record IDs are immutable.

Depending on the size of your table, this could be prohibitively compute intensive, therefore it's very important to think carefully about your record IDs.

Now we get to the part where the `INSERT` statement becomes more Surreal, as it also accepts JSON-like objects. Let's insert a single record into our table to see what that looks like.

```surql
INSERT INTO product {
    name: 'Cruiser Hoodie',
    colours: ['Dark Heather Grey','Bubble Gum Pink'],
    price: 59,
    time: {
        created_at: time::now(),
        updated_at: time::now()
    }
};
```

Unlike the `CREATE` statement, `INSERT` does not use the `CONTENT` keyword after the table name. Adding it here would cause an error, just like forgetting `CONTENT` in `CREATE` would.

The reason for this is that `INSERT` doesn't have both `SET` and `CONTENT` and thus doesn't need to make this distinction. You can change this query and try it out if you want to see the error.

For inserting multiple records, the only difference is that instead of inserting an object, we insert a list of objects.

```surql
INSERT INTO product [
    {
        name: 'Cruiser Hoodie',
        colours: ['Dark Heather Grey','Bubble Gum Pink']
    },
    {
        name: 'Surreal T-Shirt',
        colours: ['White Pink','Purple White']
    }
];
```

This is a very convenient way to bulk insert data, especially if you're fetching the data from an API.

Most people tend to use languages like [Python](/docs/languages/python/start) or [Rust](/docs/languages/rust/start) to fetch data from APIs and insert it into SurrealDB. However, as we can see from this Pokemon API example, SurrealQL has [http functions](/docs/reference/query-language/functions/database-functions/http) that allow you to directly get and insert JSON data from an API, all in one query.

This example won't work because HTTP functions are disabled by default and in our online embedded query windows, but if you start a SurrealDB server with the `--allow-net` flag then you can see the results.

```surql
INSERT INTO pokemon http::get('https://pokeapi.co/api/v2/pokemon/pikachu/');
```

## UPSERT

The `UPSERT` statement is the final way you can insert data.

Like in other SQL dialects, the name `UPSERT` comes from being a combination of an `UPDATE` and an `INSERT` statement.

Now, we just mentioned that the `INSERT` can also `UPDATE` data, so you're probably wondering what the difference is between them. Here is an example of `INSERT` to start.

```surql
INSERT INTO product (id, name, colours)
VALUES (1, 'Cruiser Hoodie', ['Dark Heather Grey','Bubble Gum Pink']);
INSERT INTO product (id)
VALUES (1) ON DUPLICATE KEY UPDATE colours += ['Purple'];
```

The way the `INSERT` statement does upserts would seem familiar to most SQL users, using `ON DUPLICATE KEY UPDATE` which tries to `INSERT` the data and if it sees there is already a record with that id, it does an update instead.

The `UPSERT` statement has the same syntax as `UPDATE`, which we'll cover later in this part when we talk about updating data.

```surql
-- Inserts a new record
UPSERT product:01KDY9P288FMHWH6R108B1RHFX SET colours += ['Purple'];
-- Record already exists: updates the existing one
UPSERT product:01KDY9P288FMHWH6R108B1RHFX CONTENT {colours: ['Purple', 'Pink']};
```

Otherwise though it works like `INSERT`, in which it looks to insert a record but updates if the record already exists.

Apart from that the `UPSERT` follows the same syntax as the `CREATE` statement, with both a `SET` and `CONTENT` option, as well as the data generation functionality.

## Summary

We've covered a lot in this lesson! Let's summarise the main points we learned, and if you skipped right to this part, welcome!

We learned that:

- The `CREATE` statement

- Creates tables and inserts data.

- Is the only statement that can create and insert into multiple tables at the same time.

- Can only insert one record at a time to the same table (except for data generation).

- Uses both `SET` and `CONTENT` for SQL-like and JSON-like experience.

- The `INSERT` statement

- Creates a table, inserts data and updates data.

- Is the only statement that can insert multiple records into the same table.

- Can only update one record at a time, and can be instructed what to do if a record already exists.

- Doesn't use `SET` and `CONTENT`, but rather tuples like SQL and direct objects or a list of objects.

- The `UPSERT` statement

- Creates a table, inserts data and updates data.

- Is the only statement that can update an entire table.

- Tries to insert, updating if the record already exists.

- Can only insert a specific record (except for data generation).

- Uses both `SET` and `CONTENT` for SQL-like and JSON-like experience.

If you'd like to experiment with what you've learned, feel free to play around with the SurrealDB Studio query interface, you can also go back and edit or change any query you want.

When you're ready, I'll see you in the next one!
