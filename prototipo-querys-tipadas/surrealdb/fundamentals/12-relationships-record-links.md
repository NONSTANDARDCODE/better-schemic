# Record links

The second relationship type we'll be exploring is record links. We'll go through:

- How record links work

- How to practically model our data using record links

- How to use record links in our CRUD operations

## How record links work

A record link is simply an external record ID that is directly embedded in another record, similar to a foreign key in relational databases.

However, record links are different from foreign keys because they are record IDs that directly access the underlying key-value storage engine.

This allows us to traverse from record to record without needing to run a table scan query because the table and key of the ID are already known. It directly fetches the record instead of scanning for a matching needle in a haystack, like in traditional SQL joins.

## Modelling our data using record links

In the previous lesson, we created a primary relationship based on the major actions a person using our e-commerce store would take: wishlist, cart, order and review.

![](/assets/static/surreal-deal-store-links.light.oD58c42W.avif)![](/assets/static/surreal-deal-store-links.DIjNRlkp.avif)

Now we are moving on to secondary relationships. Which are:

- Making a one-way relationship from the `product` to the `seller`.

- Making bidirectional relationships to and from `address_history` and `payment_details` to the `person`.

One important thing to note before moving on, is that while we're talking about primary and secondary relationships here, you can model your data completely using graph relations or using record links.

It all depends on your needs, this is just one recommended way of doing things.

### One-way record links

```surql
UPDATE product SET seller = seller:surrealdb;
```

To make a one-way relationship from the `product` to the `seller`, we can set the record ID `seller:surrealdb` as the value of the `seller` field for all the records in our `product` table.

That way, we can link every product to information about the seller of that product. Since the Surreal Deal Store is based on our swag store, [SurrealDB.store](https://surrealdb.store/), the seller will always be SurrealDB. This is why we've created this one-to-many relationship.

An important thing to notice here is that we haven't created the `seller` table yet, but were still able to insert the `seller` record ID into the product table because there are no foreign key constraints for record links.

Let's therefore quickly create the `seller` table such that our product record link will actually go somewhere.

```surql
CREATE seller:surrealdb
SET name = "SurrealDB", email = "education@surrealdb.com"
```

### Bidirectional record links

Record links don't hold any metadata like graph links do, but they can be queried bidirectionally if you want. The way you do this is by defining them as a field of type `record`, followed by the `REFERENCE` clause. They look like this, and are at the very top of the dataset for this part of the course. This is our first look at a `DEFINE` statement, which we will look a lot more at in the next section.

```surql
DEFINE FIELD person ON TABLE address_history TYPE record<person> REFERENCE;
DEFINE FIELD person ON TABLE payment_details TYPE record<person> REFERENCE;
```

With those definitions set up, adding record links from `address_history` and `payment_details` to the `person` will let them be queried on either side. We'll look at that in a second.

```surql
CREATE address_history:ulid(), payment_details:ulid()
SET person = person:01GFFXDCG89SAR3WM2SDV2E1RA;
```

You could also just add a record link manually if you want, but as you can see it is more work.

```surql
UPDATE person:01GFFXDCG89SAR3WM2SDV2E1RA MERGE {
  address_history: address_history:01HCWCEB1R8Y499XJYPVWE04RX,
  payment_details: payment_details:01FTZ3MR7095CRDT1A04NNRQ6H
};
```

When querying an incoming record link you use this `<~` operator. It's similar to graph syntax except that it uses a `~` (a tilde or a "squiggly").

Here are two queries returning a single record that includes the record link to the person to get the person's name.

```surql
SELECT 
  addresses.country,
  person.name
FROM address_history LIMIT 1;
SELECT
  stored_cards.expiry_year,
  person.name
FROM payment_details LIMIT 1;
```

And now here are two similar queries that turn it around. This time, we are querying from the `person`, then using `<~address_history` or `<~payment_details` to access those linking records from the other end.

```surql
SELECT 
  name,
  <~address_history.addresses.country AS countries
FROM person LIMIT 1;
SELECT 
  name,
  <~payment_details.stored_cards.expiry_year AS expiry_years
FROM person LIMIT 1;
```

## Record links: CRUD operations

We've already covered how to create record links, let's now explore how to use them in the rest of our CRUD operations.

```surql
-- Selecting the current address from the person table
SELECT
    person.address.address_line_1  AS current_address,
    addresses[0].address_line_1 AS previous_address
FROM address_history:01HCWCEB1R8Y499XJYPVWE04RX;
-- Adding the current address to the address_history table
UPDATE address_history:01HCWCEB1R8Y499XJYPVWE04RX
SET addresses += person.address;
-- Deleting the address history from Leoma
-- Use RETURN BEFORE to return the record info
-- from before deletion
DELETE address_history
WHERE person.name = "Leoma Santiago" RETURN BEFORE;
```

As these examples show, you can use record links in CRUD operations in the same way as you would, if it was all embedded in the same record, using the dot and bracket notation.

## Summary

Now that we've interlinked our knowledge of record links, let's summarise what we've learned.

Record links:

- Are external record IDs that are directly embedded in other records, similar to foreign keys in relational databases, but allowing us to traverse from record to record without needing to run a table scan query.

- Require no special statement to create; inserting record IDs into other records will link them together.

- Only work in one direction by default. But if you define one with the `REFERENCE` keyword, you can query from the other direction as well.

You can use record links in CRUD operations in the same way as you would, if it was all embedded in the same record, using the dot and bracket notation.

That's everything about record links, I'll see you in the next lesson, where we'll explore relational style joins.
