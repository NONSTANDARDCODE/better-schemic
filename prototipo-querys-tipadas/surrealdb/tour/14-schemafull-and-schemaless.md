# 14: Schemafull and schemaless

Our database now has two schemaless tables.

```surql
INFO FOR DB;
```

**Response**

```surql
{
  accesses: {},
  analyzers: {},
  configs: {},
  functions: {},
  models: {},
  params: {},
  tables: {
    place: 'DEFINE TABLE place TYPE ANY SCHEMALESS PERMISSIONS NONE',
    town: 'DEFINE TABLE town TYPE ANY SCHEMALESS PERMISSIONS NONE'
  },
  users: {}
}
```

Schemaless means that the table is free to accept any sort of data that we give it. If the tables were `SCHEMAFULL`, they would have been much stricter. A schemafull table will ignore input for any field except `id` unless it is defined in advance.

```surql
DEFINE TABLE schemafull_town SCHEMAFULL;
-- schemafull_town only has one defined field
DEFINE FIELD population ON schemafull_town TYPE number;
-- So the query succeeds, but 'name' data is ignored
CREATE schemafull_town SET name = "Riverdale", population = 75000;
REMOVE TABLE schemafull_town;
```

**CREATE query output**

```surql
[
  {
    id: schemafull_town:q9olode057qz1vdzruuv,
    population: 75000
  }
]
```

The `INFO FOR` command works for other items too, like tables.

```surql
INFO FOR TABLE place;
INFO FOR TABLE town;
```

**Response**

```surql
-------- Query --------
{
  events: {},
  fields: {},
  indexes: {},
  lives: {},
  tables: {}
}
-------- Query --------
{
  events: {},
  fields: {},
  indexes: {},
  lives: {},
  tables: {}
}
```

The empty output shows that `place` and `town` are schemaless, without any defined fields. That means that we could create a town whose `name` is a completely different type, like a number.

```surql
CREATE town SET name = 9999.999999;
```

**Response**

```surql
[
  {
    id: town:x1hy1y4d21x5dlhndprc,
    name: 9999.999999f
  }
]
```

We don't want people to create towns with names like 9999.999999, so we will create a schema on the next page to ensure that this won't happen. Let's first delete this unwanted town.

```surql
DELETE town WHERE name = 9999.999999 RETURN BEFORE;
```

**Response**

```surql
[
  {
    id: town:2ciozta7zj7b8yvqfkpm,
    name: 9999.999999f
  }
]
```
