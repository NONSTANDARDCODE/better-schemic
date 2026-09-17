# Relational style joins

The third and final relationship type we'll explore is relational style joins.

We'll go through

- Semi-joins

- Anti-joins

- Correlated subqueries

Relational style joins is very intentional wording as SurrealDB doesn't do traditional SQL joins.

Instead, we have thought from first principles about what developers need from database relationships to develop easily and scale quickly.

This led us to our primary way of creating relationships at write time to simplify scaling and improve developer experience at query time.

We've covered these in our previous two lessons. Now, we will learn about semi-joins, anti-joins, and correlated subqueries.

Those are fancy terms but don't worry; it will all make sense soon enough.

## Semi-joins

A semi-join is a subquery that filters the outer query with the results of the inner query.

Now that we've got the dictionary definition out of the way, let's get to the exciting stuff by exploring the same query written in 3 different ways in both SQL and SurrealQL.

This will really help you see the difference between a semi-join, correlated subquery and a traditional SQL join.

### `IN` example

As SurrealQL is a SQL-like language, you'll notice that the examples will look very similar. See if you can spot the difference.

### SQL: `IN`

```surql
-- Outer query
SELECT name
FROM product
WHERE id IN (
  -- Inner query
  SELECT in
  FROM product_sku
  WHERE colour = "Black Pink"
)
AND id = "01G0MW4VTG8QZR3A4BTEXHXWS7";
```

### SurrealQL: `IN`

```surql
-- Outer query
SELECT name
FROM product:01G0MW4VTG8QZR3A4BTEXHXWS7
WHERE id IN (
    -- Inner query
    SELECT VALUE in
    FROM product_sku
    WHERE colour = "Black Pink"
);
```

In the SQL example since inner queries run before outer queries, it's often good to read subqueries from the inside out.

Starting with us filtering for product sku's in the `product_sku` table that have the colour of “black pink”, then "joining" the `product_sku` table to the `product` table using the `id` and `in` fields.

This then allows us to see the name of the product which has the colour "Black Pink".

In the SurrealQL example, the reason you see the `VALUE` clause added to the `SELECT` statement is because by default SurrealDB returns objects with their field names. Since we want to check if an ID is in an array of IDs, [`SELECT VALUE`](/docs/reference/query-language/statements/select#basic-usage) allows you to return an array of just the values, no field names included.

A key thing to note is that the entirety of the inner query is run before the outer query, which would make it an uncorrelated subquery. This does have some pros and cons, as we'll explore in our next example.

### Correlated subquery example

This is a subquery that filters the outer query with the results of the inner query and is a type of semi-join.

### SQL: correlated subquery

```surql
SELECT name
FROM product
WHERE EXISTS (
  SELECT in FROM product_sku
  WHERE product_sku.in = product.id
  AND colour = "Black Pink"
)
AND id = "01G0MW4VTG8QZR3A4BTEXHXWS7";
```

### SurrealQL: correlated subquery

```surql
SELECT name
FROM product:01G0MW4VTG8QZR3A4BTEXHXWS7
WHERE (
    SELECT in FROM product_sku
    WHERE in = $parent.id
    AND colour = "Black Pink"
);
```

The key difference here is that the inner query can't run without the outer query, as you can see in the `WHERE` statement.

The defining characteristic of correlated subqueries is that they reference a column in the outer query and execute the subquery once for each row in the outer query.

Now, you might be wondering, why would we do that?

Well, it might be more performant. But as always, it depends.

One of the things it depends on, is how your query optimiser handles your query. It also depends on how large the table of the inner query is and how complicated the logic is.

In our example, the product table is small and only filters on colour, so it's not a big deal to scan the whole table.

The reason why this `WHERE` condition can be more performant is because we are limiting the range of possible records to scan only those relevant to the outer query.

The key thing to remember is that you cannot assume one way is always better, as it depends on the above factors and more.

Therefore, if you need the best performance, it's worth testing both, as the results might surprise you.

## Anti-joins

Anti-joins are still a subquery that filters the outer query with the results of the inner query.

The only difference is that it's the opposite of the queries as seen in the previous examples. Instead of `IN`, it is `NOT IN`, and instead of `EXISTS`, it is `NOT EXISTS`. However, since SurrealDB doesn't use `EXIST` you can instead put an `!` exclamation mark in front of the subquery, to indicate `NOT EXISTS` like in this SurrealQL example.

```surql
SELECT name
FROM product
WHERE !(
    SELECT in FROM product_sku
    WHERE in = $parent.id
    AND colour = "Black Pink"
);
```

Ok, enough with the subqueries, let's look at how this compares to a normal SQL join.

### `JOIN` example using SQL

```surql
SELECT product.name
FROM product_sku
JOIN product ON product.id = product_sku.in
WHERE product_sku.colour = "Black Pink"
AND product_sku.in = 01G0MW4VTG8QZR3A4BTEXHXWS7
```

Just to reiterate, the `IN`, `EXIST`, and `JOIN` examples all give the same results, they just have a different way of getting there.

### Graph example using SurrealQL

```surql
SELECT <-product.name
FROM product_sku:01FRVHS08G9WMAHFQTFY82ENXQ
WHERE colour = "Black Pink"
```

As you can see in this example, things don't need to be complicated.

If you can make relationships at write time, you can completely eliminate the typical complexity. That allows you to avoid errors people make with joins at query time such as not knowing the grain of the data and whether you need a left, right, inner, outer, lateral, or cross join.

## Summary

Let's summarise what we've learned.

Semi-joins, anti-joins and correlated subqueries are all subqueries that filter the outer query with the results of the inner query.

We've shown how to:

- Use the `IN` clause along with `SELECT VALUE` for semi-joins.

- Use `NOT IN` and the exclamation mark `!` instead of `NOT EXISTS` for turning semi-joins into anti-joins.

- Use the `$parent` parameter for correlated subqueries.

- Turn a SQL join into an example with graph relations.

That's everything about relational style joins, I hope you have enjoyed this part on relationships.

Hopefully, this lesson clears up some of the fears of missing out (FOMO) that you might have had about SurrealDB not having traditional SQL joins. See you in Part 3.
