# Graph relations

The first relationship type that we'll explore is graph relations. We'll go through:

- How graphs work

- How to practically model our data as a graph using the `RELATE` statement

- How to use graph relations in our CRUD operations

## How graphs work

G equals a pair of V and E sets. G = (V, E).

That is the formal mathematical definition of a graph, but let's translate that into normal language.

Graphs are just points connected by lines, which means they come in different shapes and sizes.

![](/assets/static/tree-graph.light.B-KjRkSR.avif)![](/assets/static/tree-graph.B0zpMjk8.avif)

The points are called `nodes` or `vertices` and represent our main entities, such as your friends.

The lines are called `edges` or `links` and represent the relationships between `nodes`, such as the one between you and each individual friend.

Edges can be both unidirectional, like in this tree example, and bidirectional like in the network example.

These are the fundamentals of how graphs work.

## Modelling our data as a graph

How this works in practice in most graph databases is through something called semantic triples, which is a way to describe a graph in a three-part structure:

- subject → predicate → object

OR

- node → edge → node

Another way to think about this is in terms of nouns connected by verbs, such that it forms a sentence.

- noun → verb → noun

OR

- person → order → product

![](/assets/static/surreal-deal-store-relations.light.DmoPUw2y.avif)![](/assets/static/surreal-deal-store-relations.DPwZ74zd.avif)

### The `RELATE` statement

SurrealDB has a statement called `RELATE` that makes use of this three-part structure.

Using the `RELATE` statement, we can create our primary relationships based on the major actions a person using our e-commerce store would take: `wishlist`, `cart`, `order` and `review`. These will serve as our edge tables.

```surql
-- wishlist
RELATE person:01GT2ZEF2G8AC8D7H7FMZ1ZYZ3 -> wishlist:ulid() -> product:01HGAR7A0R9BETTCMATM6SSXPT;
-- cart
RELATE person:01HBC4FGG0904R927Q82SVZ1JB -> cart:ulid() -> product:01GXRS3FZG8Y8SDBNHMC14N25X;
-- order
RELATE person:01GCSHZEP89F1B9T33Y4M9VA9J -> order:ulid() -> product:01H35P394G93AVCEF8KX59H5RY;
-- review
RELATE person:01FSZ7A4W888FAYSSP8T3NV3MX -> review:ulid() -> product:01GBE3CTMG93XBKM07CFH1S9S6;
```

Here, we are taking an existing record ID from the `person` and `product` table. Then for the middle tables which are the edge tables.

Those get created if they don't already exist. We are also specifying that these new records should use a `ULID` as an ID.

Once we run the `RELATE` statement, we'll see two new fields: `in` and `out`.

Now you might be wondering, when were these created since it didn't seem like we specified them before. We did actually specify them using the `RELATE` statement because another way of looking at the semantic triple is in the three-part structure:

- in → id → out

Inside this structure the first node is called `in`, the edge is the `id`, and the second node is the `out`. The `in` field is the record that does something via the edge, and the `out` field is the record that has something done to it.

### Adding data to edge tables using `SET` and `CONTENT`

What really sets SurrealDB apart from graph-only databases is that our edges are also real tables. That means that you can store information in them, which allows for even more flexible data models.

```surql
-- set
RELATE person:01GT2ZEF2G8AC8D7H7FMZ1ZYZ3 -> wishlist:ulid() -> product:01HGAR7A0R9BETTCMATM6SSXPT
SET time.created_at = time::now();
-- content
RELATE person:01GFFXDCG89SAR3WM2SDV2E1RA -> order:ulid() -> product:01H35P394G93AVCEF8KX59H5RY
CONTENT {
    quantity: 2,
    ordered_at: time::now(),
    type: "expedited delivery"
};
```

We can both create our `order` relationship and use it at the same time to fetch connected data from both the `product` and `person` tables.

Notice that the direction of the arrow changes based on the table we are fetching from.

Looking at the `RELATE` statement, we can see that we only specified one direction, going from person to order to product.

However, the `RELATE` statement creates a bidirectional graph by default, meaning that even in addition to `person → order → product`, we could also query it the other way around using `person ← order ← product`.

### `RELATE` just two tables

![](/assets/static/graph-2-tables.light.CCV84BIF.avif)![](/assets/static/graph-2-tables.DsZomaNO.avif)

So far we've been focusing on connecting three tables in our semantic triple, we can however use just two tables as well, by having the `in` and `out` be the same record ID.

```surql
RELATE product:01G0MW4VTG8QZR3A4BTEXHXWS7 -> product_sku:ulid() -> product:01G0MW4VTG8QZR3A4BTEXHXWS7;
```

### Inserting multiple relations

There are two ways to `INSERT` multiple relations.

The first way is by using the `RELATION` clause on the `INSERT` statement. It works the same way a normal `INSERT` would, just with the `in` and `out` fields being required to specify the relationship.

```surql
INSERT RELATION INTO order [
  {
    id: order:01J9XESXSQ5S69ZCDMVGGFVQVQ,
    in: person:01J9XESXSQ7NKPDSWZ4963QPP1,
    out: product:01J9XESXSQK2078BKKJ7S6JPC2
  },
  {
    id: order:01J9XESXSQ0XVDKQ86W943A97H,
    in: person:01J9XESXSQTK65SKAWGZ6MNGP6,
    out: product:01J9XESXSQFK0D4F49V2DWHQP3
  },
  {
    id: order:01J9XESXSQAZPSGK6JH12FB72E,
    in: person:01J9XESXSQ0S2384128FSBY6Q4,
    out: product:01J9XESXSQ11KQYV9RP3SSR6ED
  }
]
```

The second way is to do a Cartesian product using the `RELATE` statement. Here's what it looks like using the parameters `$person` and `$product` to keep the final query readable.

```surql
LET $people = (SELECT VALUE id FROM person LIMIT 10);
LET $products = (SELECT VALUE id FROM product LIMIT 10);
RELATE $people->order->$products TIMEOUT 3s;
```

This creates a relationship record for each combination of record IDs. Such that if we have 10 records each in the `person` and `product` tables, we get 100 records in the `order` edge table.

When experimenting with queries like this that may end up using a lot of your available resources, it can be a good idea to add a `TIMEOUT` clause to have the query fail if it exceeds a certain limit.

## Graph CRUD operations

We've already covered how to create graph relations, let's now explore how to use them in the rest of our CRUD operations.

```surql
SELECT
    <-person.name AS person_name,
    in.name,
    ->product.seller,
    out.seller
FROM order LIMIT 4;
UPDATE order
SET shipping_address = <-person.address;
// ?= means "if any are equal"
DELETE order
WHERE <-person.name ?= "Leoma Santiago"
```

## Summary

Now that we've tackled learning graphs, let's summarise what we've learned.

Graphs work by:

- Creating `nodes`, also called `vertices`, as your main entities.

- Creating connections between these `nodes` using `edges` which can be unidirectional or bidirectional

Let's also summarise what we have learned for the `RELATE` statement. A `RELATE` statement creates a graph using a semantic triple, which has the following structure:

- subject → predicate → object

For example, `person → order → product`.

It creates a bidirectional graph by default, meaning that even if we only specified `person → order → product` it can also be queried as `person ← order ← product`.

- It can include data along with the relationship, as our edges are just another table type.

- It creates a number of edges equal to the Cartesian product of the number of records on the left multiplied by the right side.

- The `RELATION` clause on the `INSERT` statement, `INSERT RELATION INTO`, is used to `INSERT` multiple records. It works in the same way as a normal `INSERT` except that the `in` and `out` fields are required to specify the relationship.

You can also use graph relations in any CRUD operation either by using the arrow syntax `<- ->` or dot notation using `in` and `out`. Both are valid ways of querying the data.

That's everything about graph relations, I'll see you in the next lesson, where we'll explore record links.
