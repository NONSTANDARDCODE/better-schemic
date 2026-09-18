# 25: Defining indexes

[Indexes](/docs/reference/query-language/statements/define/indexes) can be defined in SurrealDB for a number of ways. The main reason for an index is faster data retrieval. This is used most often when you need to use the `WHERE` clause in a query, which results in a full table scan. But with an index, this is much faster.

```surql
CREATE person SET name = "Billy";
-- Create 25000 more records, each with a random string for a name
CREATE |person:25000| SET name = rand::string(10) RETURN NONE;
-- Lots of 'person' records to look through...
SELECT * FROM person WHERE name = "Billy";
-- Add an index
DEFINE INDEX name_index ON person FIELDS name;
-- The same query is much faster now
SELECT * FROM person WHERE name = "Billy";
```

Our database has nowhere near 25,000 records so an index for faster lookup times won't be necessary at this point. However, an index has other uses such as being able to ensure that records are unique. To do this, just add the keyword `UNIQUE` to the end.

One place we can use a unique index is the `address` field on the `place` table.

```surql
DEFINE INDEX unique_address ON TABLE place FIELDS address UNIQUE;
CREATE place SET
    name = "Wrong house",
    address = "2025 Statement Street, Riverdale",
    place_type = "building";
```

**Response**

```surql
"Database index `unique_address` already contains
'2025 Statement Street, Riverdale', with record `place:surreal_library`"
```

A unique field can be defined on multiple fields too, such as this one defined on the `in` and `out` fields of a graph edge. This is used quite often to make sure that a `RELATE` statement can't be used more than once on the same two records.

```surql
DEFINE INDEX can_only_like_once ON TABLE likes FIELDS in, out UNIQUE;
RELATE person:one->likes->person:two;
RELATE person:one->likes->person:two;
```

**Response**

```surql
'Database index `can_only_like_once` already contains
[person:one, person:two], with record `likes:6lx7cqzesfh9jkic60c2`'
```
