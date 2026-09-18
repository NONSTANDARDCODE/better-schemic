# Part 1: Schemaless CRUD

SurrealDB stores and presents data like a document database, using JSON-serializable records.

We'll start with tables, which can have many records, which themselves can have many fields. In this table, you can see the equivalent terminology for the basic building blocks SurrealDB uses.

| SurrealDB | Document DB | Relational DB | Graph DB |
| --- | --- | --- | --- |
| Table | Collection | Table | Node label |
| Record | Document | Row | Node |
| Field | Field | Column | Node property |

Each record is stored on an underlying key-value storage engine, with the ability to store arbitrary arrays, objects, and many other datatypes.

One of the main reasons SurrealDB chose to use document-style JSON-serializable records is because, for better or worse, the world runs on JSON now.

Now, it's not a question of document vs relational as every major relational database has had to add JSON support to stay relevant in a world where semi-structured data is the norm, with almost every website, app, IoT device and AI chatbot producing it.

The question therefore is, do you want a first-class experience for semi-structured data or do you want a second-class experience?

For many developers, not having this means a lot of time ingesting semi-structured data and normalising it, just to denormalise it again into materialised views and indexes to improve performance.

It tends to be the case that data always ends up being duplicated, while the choice is just between duplicating it in the storage layer or duplicating it in the compute layer. Storage used to be expensive, so it made sense to optimise storage to save on compute. However nowadays, it's the opposite. Storage is cheap, and compute is expensive. Therefore, I think it makes sense to optimise for compute if you care about reducing costs. That usually means reducing joins and denormalising data.

Debugging and fixing the [object-relational impedance mismatch](https://en.wikipedia.org/wiki/Object-relational_impedance_mismatch) is another time sink, and the primary underlying cause of almost all of the object-relational mapping (ORM) performance issues many developers have seen.

Storing objects as objects avoids these messy conversions and allows for much more flexible data modeling.

That is not to say document databases don't have problems. If you'd ask any random person who did a database migration from SQL to NoSQL and back to SQL, they would list loads of problems such as:

- Hating the query language and preferring SQL

- ACID transactions turn out to be really important

- Relationships turn out to be really important too

- Being able to define a schema at the database level is often crucial

These are all problems SurrealDB has fixed by taking the best ideas from the graph and relational model and combining them with the other types of models. We'll cover that in more detail in part 2 about relationships and part 3, where we'll make things schemafull.

However, in this part we are focusing on learning how to make use of the schemaless data patterns and why records and record IDs can be magical.

We've covered records here already, next we'll take a deep dive into the magic of record IDs and then learn how to create, read, update and delete (CRUD) data the SurrealDB way.

![](/assets/static/surreal-deal-store-schema.light.C3tlzGEQ.avif)![](/assets/static/surreal-deal-store-schema.DSIPu1Ke.avif)

Looking at the Surreal Deal Store schema again, we can see that the two foundational tables are `person` and `product`. We'll focus in this part on just these two tables and then add the remaining tables in part 2 when we talk about relationships.

That's it for now and I'll see you in the next one.
