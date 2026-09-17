# Record IDs

The first thing to be aware of is that in SurrealDB, a record ID has two parts: a table name and a record identifier. Together, they look like this: `table:record`.

The second thing to be aware of is that they are immutable, meaning that the ID of a record can't be changed once it is created. This is why we'll spend some time exploring the different options you have so you can pick the best ID for your use case.

By default, when you use a statement like `CREATE my_table` to create a record from a table, you'll notice two things:

- SurrealQL has very few reserved words.

- The second thing you'll notice is that a random ID is assigned.

This differs from the traditional default of autoincrement or serial IDs you might be used to.

It also allows you to avoid common scaling problems such as:

- Auto incrementing that locks, impacting concurrency and scalability of your database.

- Accidental information disclosure through using IDs in URLs, giving away data size and velocity.

- Non-uniqueness across tables or table shards across distributed nodes

## Generated record IDs

The typical solution to this is to use randomly generated identifiers such as our default `rand::id()` which can be explicitly stated like so:

```surql
CREATE product;
CREATE product:rand();
LET $id = rand::id();
CREATE product SET id = $id;
```

Realistically you'd never really have to explicitly state them unless you change your default IDs and need them for some reason. But it's good to know that is what is happening under the hood.

However, while our random IDs are a great default option, they aren't the only option.

For an e-commerce application where things are often based on time, it can make sense to have a time-sortable id, as was the case for [Shopify switching from UUID v4 to ULID](https://www.youtube.com/watch?v=f53-Iw_5ucA).

SurrealDB also supports [`UUID v7`](/docs/reference/query-language/language-primitives/data-types/record-ids#random-ids), which does pretty much the same thing. The honest reason `ULID` was chosen here is just because it's shorter and looks better.

```surql
-- ULID IDs look like product:01KE63F3FEWB86K01BS3J89GK1
CREATE product:ulid();
LET $ulid = rand::ulid();
CREATE product SET id = $ulid;
-- UUID IDs look like product:u'019b8c37-8dee-77b0-b28b-489ef240d883'
CREATE product:uuid(); # UUIDv7
LET $uuid = rand::uuid();
CREATE product SET id = $uuid;
```

You can also explicitly specify which `UUID` version you want, choosing between v4 and v7.

```surql
LET $uuidv4 = rand::uuid::v4();
LET $uuidv7 = rand::uuid::v7();
CREATE product SET id = $uuidv4;
CREATE product SET id = $uuidv7;
```

Version 7 is a new `UUID` version that is time-sortable. Version 4 has been the most commonly used version and is completely random.

`ULID` and `UUIDv7` naturally sort your data based on creation time, which enables you to better use our range query pattern for highly efficient operations regardless of table size.

Speaking of highly efficient operations, the way SurrealDB handles records as we learned earlier is by storing them in the underlying key-value storage engine. But I waited until now to tell of about the magic this unlocks because the key is the same as the record ID you see here. Therefore when you use record IDs you can directly fetch individual records straight from the underlying key-value store without any table scan!

This means when doing CRUD with one or more record IDs it will have near-constant performance regardless of scale! Of course, there is an “it depends” here as the actual performance also depends on the storage engine you choose, but we'll cover that in more detail in part 5.

## Explicit record IDs

We've seen that a convenience can be used to generate an ID, but you can also explicitly set it.

You can name your tables and IDs any combination of letters and numbers separated by an underscore as long as the first character is not a number.

```surql
CREATE product:coacher;
CREATE more_product SET id = 'Surreal_T_Shirt';
CREATE product:1;
CREATE product SET id = 2;
-- These won't work:
-- CREATE 10_product;
-- CREATE product:Surreal T-shirt;
```

So what happens if we do this?

```surql
CREATE product SET id = 'Surreal T-Shirt';
```

It actually succeeds, but it puts backticks around it.

You can put backticks around anything else, like if we really did want a table name that starts with a number, or even Chinese characters.

```surql
CREATE `101_dalmations_character` SET name = "Dante";
CREATE `產品`:`超現實主義T恤`;
```

If you're wondering what the second record says, it's still just “product:Surreal T-shirt”.

You can even use emojis to represent the table and the key!

```surql
CREATE `🚪`:`🔑`;
```

Now you might say that this is not a table but a door and you'd be right, because for some strange reason there is no table emoji, which honestly came as quite a shock to us when we needed it for this example. In any case though, please don't use emojis unless it actually makes sense because remember record IDs are immutable so you'll be stuck with it.

## Complex record IDs

What you can also use is complex record IDs inside an array. These even support dynamic expressions, allowing parameters and function expressions to be used as values within the IDs!

```surql
-- Array-based record ID
CREATE review:['Surreal T-Shirt', time::now()];
```

This is useful in various ways, such as a time series context or ensuring locality between specific records in a table.

This effectively creates clustered indexes and partitions naturally in your data as you scale with the performance of the ID lookup regardless of size!

While this does not replace traditional indexes or partitions for your data, it offers additional flexibility to model the data in a performant way.

## Serial record IDs

The last thing we are going to look at is how to use auto increment or serial IDs.

You might remember that we just talked about the problems they have and what to use instead.

Even so, there are use cases where that might be a legal requirement or some other requirement you might have, so there is a way to do it with custom queries.

```surql
-- increment example
DEFINE FUNCTION fn::increment($name: string) -> int {
    (UPSERT ONLY type::record('counter', $name)
    SET value += 1).value;
};
LET $increment = fn::increment('test');
CREATE test SET id = $increment;
```

You can also [define a sequence](/docs/reference/query-language/statements/define/sequence) which will increment using a function. Note that sequence numbers are never rolled back, so if a query that returns the number 3 fails you will see the number 4 the next time you use it.

```surql
DEFINE SEQUENCE seq;
CREATE product SET id = sequence::nextval("seq"); -- product:0
CREATE product SET id = sequence::nextval("seq"); -- product:1
CREATE product SET id = sequence::nextval("seq"); -- product:2
CREATE product SET 
    id = sequence::nextval("seq"),
    other = THROW "Error!!"; -- Throw an error, transaction fails
CREATE product SET id = sequence::nextval("seq"); -- product:4
```

Custom functions and sequences are out of scope for this course, so we won't go into any more detail about how they work, but you're welcome to play around with it before we move on. In part 3 about defining a schema, I'll show you how to change your default ID to this, if you need it.

Regarding functions, what I will say for now is that you can put any valid SurrealQL into them, so you will understand what is happening in that function by the end of this part.

If you're curious though, you can [learn more about custom functions in the documentation](/docs/reference/query-language/statements/define/function).

Alright, let's move on to inserting more than just IDs.

Which ID should you choose?

**Your IDs need to be supported in multiple systems and be as unique as possible.**

**Which id most closely matches those requirements?**

Suggestion

```surql
-- the u prefix tells SurrealDB that this is a UUID, not a string
CREATE product SET id = product:u'e601950f-6792-4977-b488-ddc7b332fdb7';
LET $uuidv4 = rand::uuid::v4();
CREATE product SET id = $uuidv4;
```

**You need time-based IDs, which IDs would you choose?**

Suggestion

```surql
-- UUIDv7
CREATE product:uuid();
-- ULID
CREATE product:ulid();
-- Array-based record ID
CREATE product:['Surreal T-Shirt', time::now()];
```

**You don't have specific requirements, which IDs should you use?**

Suggestion

```surql
CREATE product;
```
