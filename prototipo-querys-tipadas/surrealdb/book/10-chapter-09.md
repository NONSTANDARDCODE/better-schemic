# Chapter 9: A peaceful interlude

**Time elapsed: 2y**

> *Two years have passed since Landevin joined. You have set up a service for anyone who wishes to get information from the database. At first you allowed visitors to print the information, but soon ran out of ink and don't know how to produce the "cartridges" that printers need. They certainly don't use regular ink! Visitors now bring their own paper and write down what they see on the computer screens.*

> *This is the case with a lot of the ancient technology, like those "DVDs" in the library that nobody knows how to use. There is certainly no device anywhere that fits them. On the other hand, a lot of ancient knowledge has been useful from day one. Simple facts like "lead is poisonous" and "boiling water makes it clean" have already led to a much healthier - and faster growing - population.*

> *Landevin is now a core member of the team. He has a good understanding of the database, but spends more time out in the open - which you envy him a bit for. He has been spreading the word about the coming new era, even to the cities across the bay.*

> *Landevin has shown an interest in the mysterious grey book you discovered so long ago, and keeps reading it over lunch. One day he asks you if he can borrow it "for inspiration" and to try to figure out the formula. Sure, why not? You lend it to him and get back to other tasks.*

> *You have doubled the guard outside the tunnel on the advice of the Toria government. They trust the local people, but other cities might react differently to the news of your project. Better safe than sorry.*

> *The mountains to the east keep the rest of the world ignorant for now. They will find out one day, but there is much work to do in the meantime...*

The last chapter marked the end of our first small multi-chapter project, and it's time to relax a bit after all that practice with graph queries. Now that we are somewhat familiar with SurrealDB, let's turn to a somewhat more philosophical discussion. What sort of database is SurrealDB anyway?

## What multi-model means

SurrealDB is written in [Rust](https://www.rust-lang.org/), and is known as a multi-model database. Multi-model means that you have the choice of one or more data models to choose from inside a single database.

Fortunately, at this point you have already used all of SurrealDB's data models! And this is why we've waited until Chapter 9 to introduce the subject, because explaining concepts like this is always easier *after* you've had some practical experience.

The major models used in databases are:

- *Document databases*, which use JSON-like documents to store and query data.

- *Relational databases*, which use a strictly defined schema to specify the relationship between one table and another.

- *Graph databases*, which use nodes and edges to represent and store data.

SurrealDB has all three. One large benefit when using SurrealDB is that you don't have to use multiple databases such as one for relational data, another for schemaless document data, another for time-series data, another for graph data, and so on and so forth.

Just imagine how hard Aeon's task would have been if there were not one, but five databases to learn! That's unimaginable for someone still new to computers and even modern technology in general.

You can think of the document model as SurrealDB's default state, because a running SurrealDB instance will always be ready to store and query document data. Thus, you can start out with schemaless records (document database style):

```surql
CREATE town:toria SET
    name = "Toria",
    population = 21520;
```

And later decide to define a schema to make the data more predictable (relational database style):

```surql
-- Strictly defining just a single field
DEFINE FIELD name ON TABLE town type string;
-- Now this CREATE statement won't work
CREATE town:black_bay SET
    name = 100,
    population = 4304;
```

**Response**

```surql
"Found 100 for field `name`, with record `town:black_bay`, but expected a string"
```

You can query records and nested fields in a document-style manner:

```surql
CREATE person:harris_thomas SET
  name = "Harris Thomas",
  salary = 100;
CREATE town:black_bay SET
  name = 'Black Bay',
  population = 4304,
  mayor = person:harris_thomas;
SELECT name, mayor.salary FROM town;
```

**Response**

```surql
[
  {
    mayor: {
      salary: 100
    },
    name: 'Black Bay'
  },
  {
    mayor: {
      salary: NONE
    },
    name: 'Toria'
  }
]
```

Or add and query relations as you see fit (graph database style) like this:

```surql
CREATE town:sukh SET
  name = 'Sukh',
  population = 3074;
RELATE [town:black_bay, town:sukh]->suburb_of->town:toria;
SELECT name, <-suburb_of<-town AS suburbs FROM town;
```

**Response**

```surql
[
  {
    name: 'Black Bay',
    suburbs: []
  },
  {
    name: 'Sukh',
    suburbs: []
  },
  {
    name: 'Toria',
    suburbs: [
      town:black_bay,
      town:sukh
    ]
  }
]
```

One point to remember is that all three of these models relate to the query language, and are unrelated to the method you use to store your data. SurrealDB documentation calls this the "Query layer" and the "Storage layer", which are kept completely separate from each other. As a result, all of the queries above have the same behaviour, regardless of whether we keep the data in memory, or use the available backends such as memory, RocksDB, or SurrealKV.

## Flexible by default but as strict as you like

A philosophical point about SurrealDB is that it is flexible by default, with as much strictness added on as you like. Strictness tends to increase over time as a project develops and you understand what sort of data you want to allow and disallow.

On the table level, there are generally three levels of strictness.

### `SCHEMALESS` with no `STRICT` clause

This is the default in which anything goes. In this mode, SurrealDB will not only stay out of your way, but unseen to us will use `DEFINE TABLE` statements to make a query work where necessary. We can demonstrate this by opening up a new sandbox inside SurrealDB Studio, and using some `INFO FOR` commands.

We are quite familiar with `INFO FOR DB` already, but there are two levels above this: `INFO FOR NS` to see the databases inside a namespace, and `INFO FOR ROOT` to see all of the defined namespaces.

Using those three `INFO FOR` statements will all show nothing, as expected.

```surql
INFO FOR ROOT;
INFO FOR NS;
INFO FOR DB;
```

The `INFO FOR ROOT` command shows a lot of system info and a definition for the current namespace, like `DEFINE NAMESPACE sandbox`. The `INFO FOR NS` command that follows shows `DEFINE DATABASE sandbox` to get that database set up. But inside the `INFO FOR DB` output there is nothing, because there is no way to predict which tables we are going to use.

**Response**

```surql
-------- Query --------
{
	accesses: {},
	namespaces: {
		ns: 'DEFINE NAMESPACE sandbox'
	},
	nodes: {
		"00765f65-1cb0-4287-bf7a-024cd0c103be": 'NODE 00765f65-1cb0-4287-bf7a-024cd0c103be SEEN 1762926401865 ACTIVE'
	},
	system: {
		available_parallelism: 14,
		cpu_usage: 0.8688058853149414f,
		load_average: [
			2.54638671875f,
			3.1943359375f,
			3.1279296875f
		],
		memory_allocated: 14054392,
		memory_usage: 86376448,
		physical_cores: 14,
		threads: 32
	},
	users: {}
}
-------- Query --------
{
	accesses: {},
	databases: {
		sandbox: 'DEFINE DATABASE sandbox'
	},
	users: {}
}
-------- Query --------
{
	accesses: {},
	analyzers: {},
	apis: {},
	configs: {},
	functions: {},
	models: {},
	params: {},
	tables: {},
	users: {}
}
```

If we type `CREATE person SET name = "Aeon"` and then try the `INFO FOR DB` statement, the output will no longer be empty. The database has taken care of the table's basic definition for us.

```surql
{
  accesses: {},
  analyzers: {},
  functions: {},
  models: {},
  params: {},
  tables: {
    person: 'DEFINE TABLE person TYPE ANY SCHEMALESS PERMISSIONS NONE'
  },
  users: {}
}
```

Also note that a `SCHEMALESS` table doesn't need any field definitions to work. So SurrealDB did not define a `name` field for us when we created a `person` record, as the `INFO FOR TABLE` statement shows. There's no need to define any fields on a table when a table by nature will accept anything.

```surql
CREATE person SET name = "Aeon";
INFO FOR TABLE person;
```

**Response**

```surql
{
  events: {},
  fields: {},
  indexes: {},
  lives: {},
  tables: {}
}
```

### Adding the `STRICT` clause

If you don't want the database to use `DEFINE TABLE` statements unknown to you, you can define it with the `STRICT` clause. Let's see what happens when we define a database that is strict.

```surql
DEFINE DB strict_db STRICT;
-- Move to the new database with `USE`
USE DB strict_db;
CREATE person SET name = "Aeon";
-- "The table 'person' does not exist"
```

Pretty straightforward! In a database that is `STRICT`, you'll have to do the definition first. This can be as simple as `DEFINE TABLE person`, which will evaluate to the default `DEFINE TABLE person TYPE ANY SCHEMALESS PERMISSIONS NONE`.

```surql
DEFINE TABLE person;
CREATE person SET name = "Aeon";
INFO FOR DB;
```

Now let's see how we can make the tables themselves more and more strict.

### SCHEMALESS with defined fields

To make a SCHEMALESS table more strict, we can define its fields and its types. Take a look at the following field statements for a `person` table.

```surql
DEFINE FIELD name      ON TABLE person TYPE string;
DEFINE FIELD job_title ON TABLE person TYPE option<string>;
DEFINE FIELD friends   ON TABLE person TYPE option<array<record<person|cat|dog>>>;
```

Each of these statements allows progressively more flexibility. Let's take a look at them starting from the most strict one.

- `name`: A `person` must have a name, and it must be a string.

- `job_title`: A `person` might or might not have a job title, but if present then it must be a string and nothing else.

- `friends`: A `person` might or might not have friends, and a friend can be one of three record types: a `person`, `cat`, or `dog`. The `|` operator can be used whenever you want to accept more than a single type: `bool|string`, `string|object|array<string>`, and so on.

But outside of these three defined fields, `person` itself is still `SCHEMALESS` so anything goes! The field definitions won't stop you from creating a record like the one in the query following them in this next example.

```surql
DEFINE FIELD name      ON TABLE person TYPE string;
DEFINE FIELD job_title ON TABLE person TYPE option<string>;
DEFINE FIELD friends   ON TABLE person TYPE option<array<record<person|cat|dog>>>;
CREATE person SET
    name = "Citizen of Toria",
    friend = snake:one,
    job_titles = ["Snake seller", "Coffee shop owner"];
```

### SCHEMAFULL

If you add a `DEFINE TABLE person SCHEMAFULL` statement before the `DEFINE FIELD` statements above, there will no longer be any way to set a value for a field that isn't already defined.

```surql
DEFINE TABLE person SCHEMAFULL;
DEFINE FIELD name ON TABLE person TYPE string;
DEFINE FIELD friends ON TABLE person TYPE option<array<record<person|cat|dog>>>;
DEFINE FIELD job_title ON TABLE person TYPE option<string>;
```

In addition, a statement like `CREATE` that includes any input that isn't defined as a field will not work.

```surql
DEFINE TABLE person SCHEMAFULL;
DEFINE FIELD name ON TABLE person TYPE string;
DEFINE FIELD friends ON TABLE person TYPE option<array<record<person|cat|dog>>>;
DEFINE FIELD job_title ON TABLE person TYPE option<string>;
CREATE person SET
    name = "Citizen of Toria",
    friend = snake:one,
    job_titles = ["Snake seller", "Coffee shop owner"];
```

Here is the error:

**Response**

```surql
"Found field 'friend', but no such field exists for table 'person'"
```

If you have some content in a form that doesn't quite fit a `SCHEMAFULL` table, you can use the `CONTENT` clause and then destructure it.

```surql
LET $too_much_content = { 
  name: "Citizen of Toria", 
  friend: snake:one, 
  job_titles: ["Snake seller", "Coffee shop owner"]
};
CREATE person CONTENT $too_much_content.{
  name,
  job_title: job_titles[0] + ' and ' + job_titles[1]
};
```

Changing the original `job_titles` into a single `job_title` string means that the input now matches the schema and the query works. Though this user who does have a friend of type `record<snake>` will probably ask for a revision to the schema!

```surql
[
  { 
    id: person:y8m4p2jatvn67zjjgu5b, 
    job_title: 'Snake seller and Coffee shop owner', 
    name: 'Citizen of Toria' 
  }
]
```

## Other combinations of strictness and flexibility

Besides the three general levels of strictness mentioned above, there are a lot of other areas that allow you to refine your database schema.

### Setting a table to TYPE NORMAL and TYPE RELATION

A table by default can be used as either a normal table or a relation table. This means that there is nothing stopping you from using the same name as a relation table to create a regular record.

```surql
CREATE person:the_nobleman SET name = "The Nobleman";
CREATE person:adelaide     SET name = "Adelaide";
RELATE person:the_nobleman->parent_of->person:adelaide;
CREATE parent_of SET name = "I'm the parent of Adelaide!";
SELECT in.name AS parent_name, out.name AS daughter_name FROM parent_of;
```

The response makes it look like we have two `person` records that lack a value for the `name` field, when really it's just the random `parent_of` non-relation record that is showing up in the query!

**Response**

```surql
[
  {
    daughter_name: NONE,
    parent_name: NONE
  },
  {
    daughter_name: 'Adelaide',
    parent_name: 'The Nobleman'
  }
]
```

This can be prevented with a quick `TYPE RELATION` in the table definition.

```surql
DEFINE TABLE parent_of TYPE RELATION;
```

With this in place, the attempt to create a random `parent_of` record fails, and the following query shows only the `parent_of` relation between the Nobleman and his second daughter.

```surql
DEFINE TABLE parent_of TYPE RELATION;
CREATE person:the_nobleman SET name = "The Nobleman";
CREATE person:adelaide     SET name = "Adelaide";
RELATE person:the_nobleman->parent_of->person:adelaide;
CREATE parent_of SET name = "I'm the parent of Adelaide!";
SELECT in.name AS parent_name, out.name AS daughter_name FROM parent_of;
```

**Response**

```surql
-------- Query --------
'Found record: `parent_of:5d13w4hqkjzticd7bz5b` which is not a relation, but expected a RELATION'
-------- Query --------
[
  {
    daughter_name: 'Adelaide',
    parent_name: 'The Nobleman'
  }
]
```

Similarly, if you define a table as a `TYPE NORMAL`, it won't be able to be used in a `RELATE` statement.

```surql
DEFINE TABLE person TYPE NORMAL;
```

For further type safety on `TYPE RELATION` tables, you can set what the `IN` and `OUT` types must be.

```surql
DEFINE TABLE parent_of TYPE RELATION IN person OUT person;
CREATE person:the_nobleman SET name = "The Nobleman";
CREATE person:adelaide     SET name = "Adelaide";
CREATE book:demian;
RELATE person:the_nobleman->parent_of->person:adelaide;
RELATE person:the_nobleman->parent_of->book:demian;
```

With the last query, we were unable to make The Nobleman the parent of a book (it must be a `person`).

**Response**

```surql
'Found book:demian for field `out`, with record `parent_of:8eq51zjwoqffs9z8e1py`,
but expected a record<person>'
```

### SCHEMAFULL with the `FLEXIBLE` field clause

Let's say that Aeon wants to define a `building` table to keep track of all the buildings in a town or city, but still isn't sure how strictly to define it.

As we learned before, with `SCHEMAFULL` we can still add some flexibility with `|` for multiple types or `option` for a field that might or might not have data. On top of that, using the `object` type gives us the option to accept any object type at all. That gives us a schema that looks like this for `building`:

```surql
DEFINE TABLE building SCHEMAFULL;
DEFINE FIELD identifier ON TABLE building TYPE string | number;
DEFINE FIELD metadata ON TABLE building TYPE option<object>;
```

This lets us create a building with a name:

```surql
CREATE building SET identifier = "Mayor's House";
```

**Response**

```surql
[
  {
    id: building:29pcok5o9rib5iicgt1g,
    identifier: "Mayor's House"
  }
]
```

Or a building with a number instead of a name as its identifier, and some metadata instead to give some idea of what sort of building it is.

```surql
CREATE building SET identifier = 0, metadata = {
    location: "Central Toria next to Mayor's House",
    next_to: (SELECT * FROM building WHERE name = "Mayor's House"),
    floors: 3
};
```

But wait a second...the query didn't work!

**Response**

```surql
"Found field 'metadata.floors', but no such field exists for table 'building'"
```

The issue here is that we are using a `SCHEMAFULL` table. The `metadata` field does indeed accept an `object`, but none of its fields have been defined. An object inside a `SCHEMALESS` table is itself schemaless, while an object field on a `SCHEMAFULL` table is schemafull unless you add the `FLEXIBLE` field clause.

Here we have two options.

One is to add `FLEXIBLE` after `TYPE` on the field. The type is still `option<object>`, but the clause tells SurrealDB to treat objects in that field as schemaless:

```surql
DEFINE TABLE building SCHEMAFULL;
DEFINE FIELD identifier ON TABLE building TYPE string | number;
DEFINE FIELD metadata ON TABLE building TYPE option<object> FLEXIBLE;
```

As a result, the `object` for the `metadata` field can now hold anything we like. Let's try the query with the metadata again:

```surql
CREATE building SET identifier = "Mayor's House";
CREATE building SET identifier = 0, metadata = {
    location: "Central Toria next to Mayor's House",
    next_to: (SELECT * FROM building WHERE identifier = "Mayor's House"),
    floors: 3
};
```

The output is now what we hoped to see.

**Response**

```surql
[
  {
    id: building:q0gmuxi1o29daankmfbv,
    identifier: 0,
    metadata: {
      floors: 3,
      location: "Central Toria next to Mayor's House",
      next_to: [
        {
          id: building:s5kylxossy75s37ix956,
          identifier: "Mayor's House"
        }
      ]
    }
  }
]
```

The other option is to define each of the fields inside the object in the same way that we would for any other field. The only difference here is that each field is a part of the `metadata` field, so it will have the field name `metadata.floors`, metadata.location`, and so on.

While we are at it, let's give these fields some assertions to make sure that its `floors` field has to be a number, and that the `location` description can't be more than 50 characters long - if they exist.

```surql
DEFINE TABLE building SCHEMAFULL;
DEFINE FIELD name              ON TABLE building TYPE string | number;
DEFINE FIELD metadata          ON TABLE building TYPE option<object>;
DEFINE FIELD metadata.floors   ON TABLE building TYPE option<number>;
DEFINE FIELD metadata.location ON TABLE building TYPE option<string> ASSERT string::len($value) < 50;
DEFINE FIELD metadata.next_to  ON TABLE building TYPE option<array<record<building>>>;
CREATE building SET name = "Mayor's House";
CREATE building SET name = 0, metadata = {
    location: "Central Toria next to Mayor's House",
    floors: 2,
    next_to: (SELECT * FROM building WHERE name = "Mayor's House")
};
```

### Making fields read-only

You can ensure that a field can only be created once and never modified by adding a `READONLY` clause. The code below shows two examples of this:

- A field called `created_at` which should be automatically generated and never modified.

- Another field called `legacy_id`, perhaps the IDs from another database that is being moved to SurrealDB by a developer who has decided that random IDs are a better solution.

```surql
DEFINE FIELD created_at  ON TABLE user READONLY VALUE time::now();
DEFINE FIELD legacy_id   ON TABLE user TYPE string READONLY;
// Plus make sure the old IDs are unique too
DEFINE INDEX only_unique ON TABLE user FIELDS legacy_id UNIQUE;
```

## Non-defined fields after move to SCHEMAFULL

What happens if you create a record without a schema, but then define the table as schemafull? Is the data inside fields not in the schema now deleted?

The answer to this is technically yes, but not right away.

The query below will explain what this means. It uses the same `building` schema as the sample directly above, but also has a `building` record that snuck in before the schema was defined.

```surql
CREATE building SET
  identifier = "Toria apartments",
    height = 10,
    kind = "apartment";
DEFINE TABLE OVERWRITE building SCHEMAFULL;
DEFINE FIELD identifier ON TABLE building TYPE string | number;
DEFINE FIELD metadata ON TABLE building TYPE option<object> FLEXIBLE;
CREATE building SET
    height = 20,
    kind = "skyscraper";
SELECT * FROM building;
```

The second `building` record we try to create fails, because at this point the table requires an `identifier` field. However, look at the output for `SELECT * FROM building`! The `kind` and `height` fields for the first record is still there.

**Response**

```surql
[
  {
    height: 10,
    id: building:tgemvaf9raf5u6ng98bs,
    kind: 'apartment',
    identifier: 'Toria apartments'
  }
]
```

The only reason why these fields are still around is that `DEFINE` simply sets the rules for a schema, and the `SELECT` query that follows is a read operation.

But once we perform a write operation like `UPDATE` on `building`, that's the end of the fields `height` and `kind`.

```surql
CREATE building SET
  identifier = "Toria apartments",
    height = 10,
    kind = "apartment";
DEFINE TABLE OVERWRITE building SCHEMAFULL;
DEFINE FIELD identifier ON TABLE building TYPE string | number;
DEFINE FIELD metadata ON TABLE building TYPE option<object> FLEXIBLE;
UPDATE building;
SELECT * FROM building;
```

**Response**

```surql
[
  {
    id: building:tgemvaf9raf5u6ng98bs,
    identifier: 'Toria apartments'
  }
]
```

So make sure to confirm whether any data would be lost when moving to a strict schema. For the record above, we could have quickly taken the `height` and `kind` data and put them into the `metadata` field, which is a flexible object. The parameter `$this` gives us access to the current record inside an `UPDATE`, so we can use it to grab the data before it is gone.

```surql
CREATE building SET
  identifier = "Toria apartments",
    height = 10,
    kind = "apartment";
UPDATE building SET metadata = {
    height: $this.height,
    kind: $this.kind
};
```

**Response**

```surql
[
  {
    id: building:sls8he2uz92cyh2bpe64,
    metadata: {
      height: 10,
      kind: 'apartment'
    },
    identifier: 'Toria apartments'
  }
]
```

You should now have a pretty good idea of how to achieve the ideal amount of strictness and flexibility in your own database.

Now let's move back a step and think about the overall structure in which a database is used, which always includes a namespace. What exactly is the relationship between a database and a namespace anyway?

## Databases, namespaces, and users

The easiest way to start learning this is by comparing the `INFO FOR NS` and `INFO FOR DB` statements to see how they differ.

The output for `INFO FOR NS` is surprisingly simple:

```surql
{
  accesses: {},
  databases: {
    db: 'DEFINE DATABASE sandbox'
  },
  users: {}
}
```

It looks like a namespace is a space that is able to contain multiple databases, plus users, and rules for access.

In practice, namespaces are most useful when you need a separate space for each tenant in an application. To do this, you can create a namespace with `DEFINE NAMESPACE`, and then create a user with the role `OWNER` (the other two roles are `EDITOR` and `VIEWER`). That user will be isolated from all other namespaces, but will be free to do anything inside the namespace in which it was defined.

We can then switch from one namespace (or database) to another via a `USE` statement. `USE NS` or `USE DB` are extremely simple, only taking the name of the namespace or database to switch to.

```surql
DEFINE NAMESPACE my_namespace;
USE NS my_namespace;
DEFINE USER someuser ON NAMESPACE PASSWORD '123456' ROLES OWNER;
INFO FOR NS;
```

**Response**

```surql
{
  accesses: {},
  databases: {},
  users: {
    someuser: "DEFINE USER someuser ON NAMESPACE PASSHASH '[REDACTED]' ROLES OWNER"
  }
}
```

So are users and accesses always kept on the namespace level? They are not! The output for `INFO FOR DB` shows this:

```surql
{
  accesses: {},
  analyzers: {},
  functions: {},
  models: {},
  params: {},
  tables: {
    person: 'DEFINE TABLE person TYPE ANY SCHEMALESS PERMISSIONS NONE'
  },
  users: {}
}
```

This is because there are three levels of system users: root users, namespace users, and database users. `INFO FOR ROOT` rounds out these three levels at the top by showing us the namespace we defined, along with the root user that was created when we used the `surreal start --user root --password root` command.

```surql
{
    namespaces: {
        ns: 'DEFINE NAMESPACE sandbox'
    },
    users: {
        root: "DEFINE USER root ON ROOT PASSHASH '[REDACTED]' ROLES OWNER"
    }
}
```

We will get into more detail on users and accesses in Chapter 15.

By the way, did you notice that every non-empty item inside these `INFO FOR` statements contains one or more `DEFINE` statements of the same name? Indeed, just about every item inside the output from the `INFO FOR` statements is related to a `DEFINE` statement. So when you see `analyzers: {}` and `params: {}`, that means that there are `DEFINE ANALYZER` and `DEFINE PARAM` statements as well. There is only one exception: `models`, which are created automatically from ML models instead of through a `DEFINE` statement. This book does not get into the subject of machine learning, but if you are curious about this subject then see [the docs for SurrealML](/docs/explore/ml-models).

## Statement parameters

We learned a few chapters ago that statements will sometimes contain predetermined parameters, such as `$before` and `$after`.

These are determined automatically by the type of operation, and not necessarily the statement name. For example, the `SELECT` statement allows you to reference `$this` for the current item, but won't have a value for `$parent` unless it is a subquery inside a larger query.

We can see this in a regular query that returns both `$this` and `$parent`:

```surql
INSERT INTO person (name, member_of) VALUES
    ("Aeon", "Management"),
    ("Landevin", "Management"),
    ("Asmodean", "Database student");
SELECT $this, $parent FROM person;
```

**Response**

```surql
[
  {
    parent: NONE,
    this: {
      id: person:2cpxa1zi62m2ltqpjgjj,
      member_of: 'Management',
      name: 'Landevin'
    }
  },
  {
    parent: NONE,
    this: {
      id: person:8qy61122gcifvu4um2gl,
      member_of: 'Database student',
      name: 'Asmodean'
    }
  },
  {
    parent: NONE,
    this: {
      id: person:co2dt3l4u1v0o4t9z72k,
      member_of: 'Management',
      name: 'Aeon'
    }
  }
]
```

As it was not a subquery, there is no `$parent` to refer to. Now let's change the query to one that does reference a parent query. This time, instead of just returning the information for each record, we want to know which other `person` records are in the same group. To do that, we will need to compare `person` records that have the same `member_of` values. We can't simply write `WHERE member_of = member_of`, because that would simply compare the current record with itself.

```surql
SELECT
  name,
  member_of,
  (SELECT VALUE name FROM person WHERE member_of = member_of) AS group_members
  FROM person;
```

But since this second `SELECT` statement is a subquery, we now have access to the parent record through `$parent` and the query will work.

```surql
SELECT
  name,
  member_of,
  (SELECT VALUE name FROM person WHERE $parent.member_of = member_of) AS group_members
  FROM person;
```

**Response**

```surql
[
  {
    group_members: [
      'Aeon',
      'Landevin'
    ],
    member_of: 'Management',
    name: 'Aeon'
  },
  {
    group_members: [
      'Asmodean'
    ],
    member_of: 'Database student',
    name: 'Asmodean'
  },
  {
    group_members: [
      'Aeon',
      'Landevin'
    ],
    member_of: 'Management',
    name: 'Landevin'
  }
]
```

There are quite a few types of parameters that may be set during an operation. The first six are:

- $before and $after

- $input

- $this and $parent

- $value

Another parameter called `$event` is used with the `DEFINE EVENT` statement which we will learn to use in Chapter 13.

These next four will also be useful later in Chapter 15 when we learn about creating users and authentication.

- $auth

- $access

- $session

- $token

But if you are curious now, feel free to stick them into any queries you use to have a look at the output generated. Here is what you will see when signed in as a root user to a running database:

```surql
RETURN [$auth, $access, $session, $token];
```

**Response**

```surql
[
  NONE,
  NONE,
  {
    ac: NONE,
    db: 'aeons_database',
    exp: NONE,
    id: '6da6462a-ae28-491e-a860-fe0a1890f449',
    ip: '127.0.0.1',
    ns: 'aeons_namespace',
    or: NONE,
    rd: NONE,
    tk: NONE
  },
  NONE
]
```

When signed in as a different type of user, you will see other information such as the access method used (`$access`).

The `$session` data in our example is interesting, as it contains `ns: 'aeons_namespace'` and `db: 'aeons_database'`. It is this data that SurrealDB uses when in non-strict mode to define the namespace and database unseen to you when you first create a table.

## Comments

We'll finish this chapter with a very small item, namely that every `DEFINE` statement can also have a `COMMENT`. A comment can only be a string, and will show up inside `INFO` statements.

```surql
DEFINE DATABASE my_database
  COMMENT "Just a test database, do not use for production";
DEFINE USER someuser ON NAMESPACE
  PASSWORD '123456'
  ROLES OWNER
  COMMENT "Just a test user, password is 123456. Seriously, do not use for production";
INFO FOR NAMESPACE;
```

**Response**

```surql
{
	accesses: {},
	databases: {
		db: 'DEFINE DATABASE db',
		my_database: "DEFINE DATABASE my_database COMMENT 'Just a test database, do not use for production'"
	},
	users: {
		someuser: "DEFINE USER someuser ON NAMESPACE PASSHASH '[REDACTED]' ROLES OWNER DURATION FOR TOKEN 1h, FOR SESSION NONE COMMENT 'Just a test user, password is 123456. Seriously, do not use for production'"
	}
};
```

Hopefully you enjoyed this peaceful interlude and a firming up of your structural knowledge of SurrealDB. In the next chapter we are going to move into the world of geography and making maps, thanks to SurrealDB's built-in geo functions.

Practice time

### 1. What will the output of this query be, and why?

```surql
CREATE person SET name = "Just a person";
DEFINE TABLE OVERWRITE person SCHEMAFULL;
CREATE person SET name = "Just a person";
SELECT * FROM person;
```

Answer

The output will be a single `person` record with data for the `name` field, along with one more that doesn't have any data for the same field. This is because `SELECT` is a read-only operation that never modifies data.

```surql
[
  {
    id: person:8y3ciyto4278na3j72le,
    name: 'Just a person'
  },
  {
    id: person:av6d23llmg7hea6ja2ah
  }
]
```

But once an `UPDATE` operation is performed, the `name` field data will no longer exist.

### 2. On which level(s) can a system user be defined in SurrealDB, and how can you find their definitions?

Answer

The answer to this one is nice and simple:

- On the root level (`INFO FOR ROOT`)

- On the namespace level (`INFO FOR NS`)

- On the database level (`INFO FOR DB`)

### 3. What definitions should you use for a graph table called `wrote` that includes a field `written_at` set to `time::now()`?

Answer

Since this is a relation table, let's make sure that SurrealDB knows that it should only be used for these purposes with `TYPE RELATION`.

```surql
DEFINE TABLE wrote TYPE RELATION;
```

After that, we'll add the `written_at` field which will be set to `READONLY` to ensure that it is never tampered with.

```surql
DEFINE FIELD written_at ON TABLE wrote READONLY VALUE time::now();
```

### 4. A database's `user` records need to hold a lot of metadata, in which two fields must be present. How should this be defined?

Here is an example of some user data. The fields `user_id` and `game_server_id` must always be present.

```surql
LET $metadata = {
    last_move: time::now(),
    location: [8.9, 10],
    user_id: 870987,
    game_server_id: 236746,
    enemies_defeated: ["Gargoyle", "Lesser demon", "Troglodyte"],
    items: {
        weapons: ["Short sword", "Morning star"],
        armour: ["Breastplate", "Leather shield"]
    }
};
```

Answer

We don't know anything about the `user` table besides this metadata, so we'll just focus on the `DEFINE FIELD` statement for the user's `metadata` field. This field should be an object followed by the `FLEXIBLE` clause, but not an `option<object>` because the fields inside the object called `user_id` and `game_server_id` must always be present.

```surql
DEFINE FIELD metadata ON TABLE user TYPE object FLEXIBLE;
```

```surql
DEFINE FIELD metadata.user_id ON TABLE user TYPE int;
DEFINE FIELD metadata.game_server_id ON TABLE user TYPE int;
```

With these definitions set up, a `user` can be created with the metadata above but won't be able to be created without its two required fields.

```surql
DEFINE FIELD metadata ON TABLE user TYPE object FLEXIBLE;
DEFINE FIELD metadata.user_id ON TABLE user TYPE int;
DEFINE FIELD metadata.game_server_id ON TABLE user TYPE int;
LET $metadata = {
    last_move: time::now(),
    location: [8.9, 10],
    user_id: 870987,
    game_server_id: 236746,
    enemies_defeated: ["Gargoyle", "Lesser demon", "Troglodyte"],
    items: {
        weapons: ["Short sword", "Morning star"],
        armour: ["Breastplate", "Leather shield"]
    }
};
CREATE user SET metadata = $metadata;
```

### 5. You have a database with `person`, `cat`, and `dog` tables that can `like` each other, but those with the name Gaston can only like themselves or others that are also called Gaston. How would you represent this?

Answer

First we will want to define the table `likes` to ensure that all three record types can like the other.

```surql
DEFINE TABLE likes TYPE RELATION FROM person|dog|cat TO person|dog|cat;
```

Once this is done, we will need to add an assertion to the `in` field to ensure that the name is either not equal to Gaston, or that both `in` and `out` are equal to each other.

```surql
DEFINE FIELD OVERWRITE in ON TABLE likes ASSERT
  $value.name != "Gaston" OR
  ($value.name = "Gaston" AND out.name = "Gaston");
```

With this done, the `person` and `dog` and `cat` records below will be unable to like anyone but themself or anyone else with the same name, as the example below shows.

```surql
CREATE person:one;
CREATE person:gaston, dog:gaston, cat:gaston SET name = "Gaston";
// Regular people can like Gaston
RELATE person:one->likes->person:gaston;
// Won't work because Gaston doesn't like regular people/dogs/cats
RELATE person:gaston->likes->person:one;
RELATE cat:gaston->likes->person:one;
// ...unless they are also named Gaston
RELATE cat:gaston->likes->cat:gaston;
RELATE cat:gaston->likes->dog:gaston;
```
