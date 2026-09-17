# Indexing &amp; data model considerations

Fundamental to performance in any database is how it handles indexing.

In this lesson, we're focusing on:

- User-defined indexes: indexes created explicitly by the user that are typically used as secondary indexes alongside the primary index.

- General data modeling and query optimisation tips.

## Creating indexes

SurrealDB offers a range of indexing capabilities designed to optimise data retrieval and search efficiency. We have:

- Traditional indexes such as single field indexes, composite indexes, unique indexes, and count indexes.

- Specialized indexes such as full-text search indexes and vector search indexes.

We'll go over traditional indexing examples and a full-text search example, but leave vector search for another time. If you're interested in vector search right now, you can check out our [vector search reference guide](/docs/learn/data-models/vector-search/overview), which explains how it works with full-text search and vector functions.

### Traditional indexes

A user-defined index is called a secondary index because it's a secondary data structure that maintains a copy of part of your data. It copies the data from the primary index, which is your primary data structure that contains all of your data. You can change the primary index by changing the storage layer as we'll explore in the next lesson.

That's enough computer science for now, for the rest of this lesson we are just going to refer to secondary indexes as indexes.

The important thing to remember is simply that when you add an index, you are creating a copy of part of your data, which the database has to keep up to date anytime you do a write operation (Create, Update, Delete) to the tables you created the index on.

This means adding an index is always a compromise between impacting your write performance to improve your read performance. Which is why we would never just add an index to everything.

So, where should we add indexes? There is no one-size-fits-all answer to this as it depends on how you are querying the database.

We might not even need an index for certain queries as it wouldn't improve the read performance.

That is the case for simple CRUD operations that rely on using record IDs, such as this `SELECT` query that is selecting two fields from a single record or a range of records.

```surql
SELECT name, email
FROM person:01FTP9H7BG8VDANQPN8J3Y857R;
SELECT name, email
FROM person:01FTP9H7BG8VDANQPN8J3Y857R..=01HG9EFC0R8DA8F87VNYP0CD8A;
```

The reason why it doesn't need an index is because it's already using an index: the primary index of the storage engine you chose for your storage layer.

When writing our queries like this next one that we normally use in relational databases, we may want an index because otherwise it results in a table scan instead of directly fetching records.

```surql
SELECT name, email FROM person
WHERE id = person:01FTP9H7BG8VDANQPN8J3Y857R;
SELECT name, email FROM person
WHERE time.created_at >= d'2022-01-30T20:06:30Z'
AND time.created_at <= d'2023-11-27T22:30:23Z';
```

To improve this we can define an index on the field we are using in our query with the `DEFINE INDEX` statement. To make sure that we know that the query is using the index, we can check by adding the `EXPLAIN` clause on the `SELECT` statement.

```surql
DEFINE INDEX person_time ON TABLE person FIELDS time.created_at;
SELECT name, email FROM person
WHERE time.created_at >= d'2022-01-30T20:06:30Z'
AND time.created_at <= d'2023-11-27T22:30:23Z'
EXPLAIN;
```

If we see that we are using `Iterate Index` instead of `Iterate Table` then we know we are using the index.

Looking at the performance of the query now with an added index, we can see that there is a huge improvement in performance. However, it is still slower than our original query using record IDs - not only because a secondary index lookup is less direct than a primary-key fetch, but also because this query returns hundreds of records rather than one.

```surql
SELECT name, email FROM person
WHERE time.created_at >= d'2022-01-30T20:06:30Z'
AND time.created_at <= d'2023-11-27T22:30:23Z';
```

This is why record IDs are so important, as you've heard me say throughout the course.

The process we just went through is a good way to start optimising your queries, which is as follows:

- Start by using record IDs whenever possible

- If not possible, such as needing a `WHERE`, `GROUP BY` or `ORDER BY` fields other then our Record ID

- Then we look at the common fields that we are using and `DEFINE INDEX` for those fields

- We then use the `EXPLAIN` clause to check if the index is working, or if we need to adjust it.

- Also importantly check if the index is actually improving the performance as there might not be a noticeable difference for small tables.

### Unique indexes

Moving on to our next example, here we have a composite index, meaning an index that has more than one field.

It's also a `UNIQUE` index, meaning it has a `UNIQUE` constraint.

This is not only for improving read performance, but the `UNIQUE` constraint also ensures that the `order` table always has a `UNIQUE` combination of the `in` and `out` fields.

```surql
DEFINE INDEX unique_wishlist_relationships 
    ON TABLE wishlist 
    FIELDS in, out UNIQUE;
-- This query works
RELATE person:01GPNJBVN09WSRFC3ZMEE6NDRG->wishlist->product:01HJN9QPNG9JAAAV19FT3GKZP0 SET 
  colour = "Blue",
  size = "M",
  time.created_at = time::now();
-- This duplicate won't, thanks to the index
RELATE person:01GPNJBVN09WSRFC3ZMEE6NDRG->wishlist->product:01HJN9QPNG9JAAAV19FT3GKZP0 SET 
  colour = "Blue", 
  size = "M", 
  time.created_at = time::now();
```

Since the `in` and `out` fields signify a relationship, this means we cannot insert a duplicate relationship into the order table.

Another way of looking at this, is that the `UNIQUE` index we are creating here functions in a similar way as a multi-field schema constraint. Because as we saw in part 3 where we made things schemafull, you can only `DEFINE` a single `TABLE` or a single `FIELD` at a time.

### Count indexes

A count index is a really easy one to put together, because it applies to a whole table and has a single `COUNT` clause. With this index, using `count()` in a statement like `SELECT` with `GROUP ALL` will access the indexed value for the number of records, instead of counting them every time. This is definitely an index to use if you have a large number of records that you need to know the exact number of.

```surql
DEFINE INDEX IF NOT EXISTS review_count ON TABLE review COUNT;
```

### Full-text search indexes

In addition to traditional indexes, SurrealDB also supports full-text search indexes. We won't cover these in detail here as they're highly configurable with many advanced features like basic and advanced text matching, proximity searches, result ranking, and keyword highlighting⁠. If you want to dive deeper, check out our [reference guide for full-text search](/docs/learn/data-models/full-text-search/overview).

```surql
DEFINE ANALYZER IF NOT EXISTS blank_snowball
    TOKENIZERS blank
    FILTERS lowercase, snowball(english);
DEFINE INDEX IF NOT EXISTS review_content
    ON TABLE review
    FIELDS review_text
    FULLTEXT ANALYZER blank_snowball BM25;
```

The definition is made up of 2 parts.

First, we define the `ANALYZER` which uses `TOKENIZERS` to split our text into words. Here we are using `blank` to split based on spaces.

Then we also need to `DEFINE INDEX` like we normally would on either single or multiple text `FIELDS` and then add the `FULLTEXT ANALYZER` we defined previously, selecting the `BM25` ranking algorithm, BM simply meaning Best Match.

Once we've done this we can double at `@@` characters in our `SELECT` statement to perform the search.

```surql
SELECT id, rating, review_text FROM review
WHERE review_text @@ 'wears nonstop';
```

We can see it's not just doing an exact search from the results but rather a semantic search. One of the results holds this bit of text that includes not just "nonstop" but also "wearing", even though we did a search using a string using the form "wears". That's thanks to the snowball filter that reduces words to more basic forms, like "wears" and "wearing" to just "wear".

```surql
"I've been wearing this hoodie nonstop since I got it.
The quality is amazing and the color is gorgeous.
I've gotten so many compliments!"
```

### One big table (OBT) vs third normal form (3NF)

Moving onto data modelling, it's important to know that the perfect data model doesn't exist.

The best way to model your data sits on a spectrum between two extremes. On one end we have the "One Big Table" (OBT), which as the name suggests, advocates for putting as much as possible in a single table. The other end of the spectrum is called the third normal form (3NF), which is the traditional data modelling approach for relational databases since the 1970s. 3NF advocates for putting as little as possible in a single table.

I can't tell you exactly how to model your data as the most performant data model is generally the one that most closely matches the business logic of your application.

That's why we think it's important for you to be able to prototype and iterate quickly, and then lock down your schema once you have found what works. That's the reason this course follows this particular journey from schemaless prototyping to schemafull constraints, and why SurrealDB holds to this approach in the first place.

## Summary

Database performance is all about finding the right balance.

Adding an index is a balance between impacting your write performance and improving your read performance.

Finding the most performant data model is a balance between putting everything in as few tables as possible and as many tables as possible.

I hope you have enjoyed the journey so far and I'll see you in our last lesson.
