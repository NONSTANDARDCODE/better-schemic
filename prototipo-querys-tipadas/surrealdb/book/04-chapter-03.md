# Chapter 3: Gone in an instant

**Time elapsed: 1d**

> *You learned quite a bit about SurrealDB yesterday, shut off the computer and went to bed feeling quite satisfied. This technology has so much potential!*

> *But the next day brought a most unpleasant surprise: all the data you created is now gone!*

> *It was all just experimental data, but still...*

> *Though you have been using computers for a full year now, the idea of losing that much information in a single moment is still a shock. Computers can both create and destroy data at such an incredible rate.*

> *As a child, you once heard about a library in the mainland across from Toria that went up in flames. Though they managed to save some of the books, the rest were reduced to ashes. The thought of losing so much knowledge in an instant still shocks you. And with computers, one false keystroke and everything is just gone!*

> *You calm yourself and begin looking through the documentation again. You soon find out why your data disappeared: the database you started yesterday with `surreal start --user root --pass secret` only kept the data in memory! That means that the information was never saved to a file. It looks like SurrealDB has a number of solutions to storing data over the long term...*

## SurrealDB architecture

SurrealDB is divided into two layers: a *query* layer (or a *compute* layer) and a *storage* layer. These are kept separate from one another, because SurrealDB has a large number of options for the storage layer, but always the same behaviour when writing queries. This lets the database feel exactly the same no matter what storage layer is being used.

Thus far we have used either the Sandbox inside SurrealDB Studio, or SurrealDB locally with commands like the following.

```surql
surreal start --user root --pass secret
```

This command has always created an in-memory database for us to use, which disappears every time we disconnect from the database. We could have also typed the following to have the same effect:

```surql
# You can type memory
surreal start --user root --pass secret memory
# Or mem:// to do the same thing
surreal start --user root --pass secret mem://
```

But `memory` is the default option, so SurrealDB will use in-memory storage even if you don't specify it.

As we noted in Chapter 1, SurrealDB will let us know which storage layer is being used when it starts up. Here is the startup output again:

```surql
2025-01-14T02:21:20.178755Z 
INFO surreal::env: Running 3.0.0 for windows on x86_64
2025-01-14T02:21:20.178923Z
INFO surrealdb_core::kvs::ds: Starting kvs store in memory
2025-01-14T02:21:20.179000Z
INFO surrealdb_core::kvs::ds: Started kvs store in memory
2025-01-14T02:21:20.179599Z
INFO surrealdb_core::kvs::ds: Credentials were provided, and no root users were found. The root user 'root' will be created
2025-01-14T02:21:20.217989Z
INFO surrealdb::net: Started web server on 127.0.0.1:8000
```

SurrealDB offers a [large number of options for storage](/docs/architecture), but their use cases are pretty clear so making a decision between them is not usually that hard.

Some of the options are:

- RocksDB: Simple, performant storage to disk. This is the main (and recommended) way to store data when using SurrealDB.

- SurrealKV: SurrealDB's in-house low-level, persistent, embedded key-value database. SurrealKV is still in beta, and is often used to develop features that eventually roll out to other backends. For example, versioning (the ability to query a table's data as it stood at a certain date), which was originally available only when using SurrealKV.

- IndexedDB: Storage inside the user's web browser.

- Memory: In-memory instances provide a certain kind of storage as of SurrealDB 3.0. There are a number of choices to make when you use this kind of storage, so we will explain how they work [later in the book](/learn/book/chapter-14#memory-plus-persistent-storage) (Chapter 14).

To instruct the database to save our data, we can replace `memory` with [some other path](/docs/reference/cli/surrealdb-cli/commands/start#positional-argument), depending on our choice of storage. For RocksDB, you can use `rocksdb://` followed by any file name we would like to give our database, like `rocksdb://mydb`. Let's try that out!

```surql
surreal start --user root --pass secret rocksdb://mydb
```

You'll see that the `Starting kvs store in memory` has changed to `Starting kvs store at relative path rocksdb://mydb`. The "relative path" part is because of the `//` two slashes, which means a relative path (a path relative to your current location). This is because sometimes people mistakenly use one `/` slash, which is used for absolute paths (a path starting from the top level).

And because it's very likely that you won't have permissions to save data at the very top level, using a single slash will often lead to these two messages:

```surql
2026-05-22T04:27:49.806842Z  INFO surrealdb::core::kvs::ds: Starting kvs store at absolute path rocksdb:/mydb
2026-05-22T04:27:49.812129Z ERROR surrealdb_server::cli: There was a problem with a transaction: Failed to create RocksDB directory: `Os { code: 30, kind: ReadOnlyFilesystem, message: "Read-only file system" }`.
```

So make sure to use two slashes most of the time!

Now that we have a running instance that saves its data, let's connect to the CLI using this command:

```surql
surreal sql --user root --pass secret
```

We will then do a simple query to create a single record.

```surql
CREATE person:aeon;
```

Now use ctrl-c to disconnect from the database and reconnect. This time you'll see something interesting in the output:

```surql
2026-05-22T04:32:02.920617Z  WARN surrealdb::core::kvs::ds: Credentials were provided, but existing root users were found. The root user 'root' will not be created
2026-05-22T04:32:02.920620Z  WARN surrealdb::core::kvs::ds: Consider removing the --user and --pass arguments from the server start command
```

That was pretty nice of SurrealDB to tell us. At this point we already had an existing database with persistent storage and a user named `root`, so we didn't need to specify `--user root --pass secret`. Good to know!

And that means that our `person` record should still be there as well. Let's give it a try.

```surql
SELECT * FROM person;
```

**Response**

```surql
[
    {
        id: person:aeon
    }
]
```

It worked!

Now that we know the basics of storage, let's get back to some queries. No chapter in the rest of the book will assume that you are using persistent storage, so feel free to go back to the SurrealDB Studio sandbox or SurrealDB in memory if you prefer.

## The `AS` keyword

The `AS` keyword lets you give an alias (an alternate name) to a selected field. This keyword is used a lot in SurrealDB, for a good reason.

First, let's look at what life would be like without `AS`. The town of The Naimo (close to Toria, where Aeon lives) currently has a population of 7490. Let's insert it.

```surql
CREATE town:the_naimo SET
  name = "The Naimo",
  population = 7490,
  data = {
    location: "Northwest of Toria",
    geography: "Coastal town"
  };
```

**Response**

```surql
[
  {
    data: {
      geography: 'Coastal town',
      location: 'Northwest of Toria'
    },
    id: town:the_naimo,
    name: 'The Naimo',
    population: 7490
  }
]
```

Easy enough!

Now let's add some weather data to a query and return that, along with some other random fields to see what they look like without an alias. The weather is cloudy with a temperature of 10.5 degrees. We'll also take the town's name and add "Weather for " in front to make "Weather for The Naimo".

```surql
SELECT
    population,
    "Weather for " + name,
    10.5,
    "Cloudy"
    FROM town:the_naimo;
```

But the output is pretty ugly!

**Response**

```surql
[
  {
    "'Weather for ' + name": 'Weather for The Naimo',
    "10.5f": 10.5f,
    Cloudy: 'Cloudy',
    population: 7490
  }
]
```

That's because SurrealDB will create the name of a field on its own from the operation used to make it. And since "Weather for The Naimo" was created by adding one string to another, the field name is just as long as its value! Even 10.5 has a somewhat ugly field name that adds an `f` to mark it as a float.

Fixing this is easy: just append `AS` and choose a name for each field.

```surql
SELECT
    population,
    "Weather for " + name AS name,
    10.5 AS temperature,
    "Cloudy" AS conditions
    FROM town:the_naimo;
```

Much nicer!

**Response**

```surql
[
  {
    conditions: 'Cloudy',
    name: 'Weather for The Naimo',
    population: 7490,
    temperature: 10.5f
  }
]
```

One thing to note when using an alias: make sure that your alias doesn't overwrite another field that you would like to display.

```surql
SELECT *,
  "Name: " + name + ". Population: " + <string>population AS data
FROM town:the_naimo;
```

The query works, but since we've outright told SurrealDB how it should output the field `data` in this query, it has no way to show the original `data` object that we inserted into the `town:the_naimo` record. It's not gone, it just won't show up in this query.

**Response**

```surql
[
  {
    data: 'Name: The Naimo. Population: 7490',
    id: town:the_naimo,
    name: 'The Naimo',
    population: 7490
  }
]
```

The easy solution is to choose a different name. But we could also give the original `data` field its own alias too. Let's give that a try.

```surql
SELECT
    *,
    "Name: " + name + ". Population: " + <string>population AS data,
    data AS other_data
FROM town:the_naimo;
```

**Response**

```surql
[
  {
    data: 'Name: The Naimo. Population: 7490',
    id: town:the_naimo,
    name: 'The Naimo',
    other_data: {
      geography: 'Coastal town',
      location: 'Northwest of Toria'
    },
    population: 7490
  }
]
```

## Updating records

Updating records is pretty easy if you already know how to use `CREATE`, because the syntax is almost the same. You can update a single record by specifying its record ID, or all the records of a table by specifying just the table name.

```surql
CREATE town:sukh SET name = "Sukh";
// Whoops, forgot to add the population...
UPDATE town:sukh SET population = 2955;
// This would set the population of both Sukh
// and The Naimo to 2955. Probably don't want to do that
UPDATE town SET population = 2955;
```

An `UPDATE` statement will show the records after they have been updated.

**Response**

```surql
-------- Query --------
[
  {
    id: town:sukh,
    name: 'Sukh'
  }
]
-------- Query --------
[
  {
    id: town:sukh,
    name: 'Sukh',
    population: 2955
  }
]
```

The largest major difference between the syntax of `CREATE` and `UPDATE` is that `UPDATE` uses a `WHERE` clause a lot, because:

- You usually don't want to update each and every record of a table.

- Much of the time you won't know the ID of the records you want to update, or the records of a table have IDs that are too complex to manually type.

So if we had created Sukh in this way...

```surql
CREATE town SET name = "Sukh";
```

**Response**

```surql
[
  {
    id: town:9aljqiup3oj78ut5aum4,
    name: 'Sukh'
  }
]
```

...we would probably end up updating it by adding `WHERE name = "Sukh"` instead of typing something like `UPDATE town:9aljqiup3oj78ut5aum4`.

```surql
CREATE town SET name = "Sukh";
UPDATE town SET population = 2955 WHERE name = "Sukh";
```

**Response**

```surql
[
  {
    id: town:9aljqiup3oj78ut5aum4,
    name: 'Sukh'
  }
]
```

## UPSERT to either create or update records

An `UPDATE` statement on a record ID won't create a record if it did not exist. Let's give this a try with an airplane, which no longer exist in Aeon's time and will certainly not be in the database at the moment.

```surql
UPDATE airplane SET name = "Aeon's plane";
UPDATE airplane:aeons_plane SET name = "Aeon's plane";
```

Each of these queries returns nothing, as expected. It would be nice though if you could treat this `airplane:aeons_plane` record ID as a pointer to some location (or potential location) in the database, which you update if it exists, and create if it does not.

This is what the `UPSERT` keyword is for! The name is a combination of `UPDATE` and `INSERT`. SurrealDB has the `INSERT` keyword as well, by the way, and we will encounter it for the first time in Chapter 7.

Let's give the former two queries a try again with the new UPSERT keyword.

```surql
UPSERT airplane:aeons_plane SET name = "Aeon's plane";
UPSERT airplane:aeons_plane SET seats = 20;
```

Now an `airplane` record is guaranteed to exist in both cases.

**Response**

```surql
-------- Query --------
[
  {
    id: airplane:aeons_plane,
    name: "Aeon's plane"
  }
]
-------- Query --------
[
  {
    id: airplane:aeons_plane,
    name: "Aeon's plane",
    seats: 20
  }
]
```

Despite its name, an `UPSERT` should not be thought of as an `UPDATE, otherwise INSERT`.

Instead, it's more like `INSERT, otherwise UPDATE`. This behaviour is common to most other databases too.

Indeed, databases probably only use the word `UPSERT` because alternatives like `INSDATE` (`INSERT`, otherwise `UPDATE`) or `CREDATE` (`CREATE`, otherwise `UPDATE`) would have looked so strange!

We can see this behaviour in the following example that starts from an empty database and attempts to update all `airplane` records, followed by an `UPSERT` for the same thing.

```surql
UPDATE airplane SET name = "Aeon's plane";
UPSERT airplane SET name = "Aeon's plane";
```

As the output shows, the `UPDATE` statement returns nothing because there is nothing to update, while the `UPSERT` statement returns an `airplane` with a random ID.

**Response**

```surql
-------- Query 1 --------
[]
-------- Query 2 --------
[
  {
    id: airplane:tcgtofmneeewxd2hq9us,
    name: "Aeon's plane"
  }
]
```

This next example on an empty database shows that an `UPSERT` will even create a record when using a `WHERE` clause. The statement will try to insert a new `airplane` record, unless it can find any records `WHERE name = "Aeon's plane"` that match to update.

Since there aren't any records that match the `WHERE` clause, it defaults to creating a new record.

```surql
UPSERT airplane 
  SET seats = 20
  WHERE name = "Aeon's plane";
```

**Response**

```surql
[
  {
    id: airplane:3438xl1xjhh5e6vmlzit,
    seats: 20
  }
]
```

The only case where you won't see a record inserted is when you try to `UPSERT` a specific record ID with a `WHERE` clause that doesn't match. In the second query in the example below, there is no way to create a new record (because we only want to operate on `airplane:aeons_plane`, which already exists), and also no way to update `airplane:aeons_plane`, because the `WHERE` clause tells the database to only do so if `name = "Government of Toria's plane"`, which isn't true. As a result, it has nothing to do and returns an empty array to show that no changes have taken place.

```surql
UPSERT airplane:aeons_plane SET name = "Aeon's plane";
UPSERT airplane:aeons_plane
  SET seats = 20
  WHERE name = "Government of Toria's plane";
```

**Response**

```surql
-------- Query 1 --------
[
  {
    id: airplane:aeons_plane,
    name: "Aeon's plane"
  }
]
-------- Query 2 --------
[]
```

Perhaps Aeon will actually have an airplane like this one day.

## Complex record IDs

Record IDs in SurrealDB can be quite complex. Besides numbers, strings, and randomly generated IDs, they can also be arrays!

Take the following query for example, which returns a `resident` record with a random `id` and two fields.

```surql
CREATE resident SET
    of = "Toria",
    name = "Aeon";
CREATE resident SET
    of = "Toria",
    name = "Mother of Aeon";
```

**Response**

```surql
-------- Query --------
[
  {
    id: resident:gqfzfid0ho1iznmj3na9,
    name: 'Aeon',
    of: 'Toria'
  }
]
-------- Query   --------
[
  {
    id: resident:4xj5gasfdq11jklmubqd,
    name: 'Mother of Aeon',
    of: 'Toria'
  }
]
```

What if you wanted the same information inside the `id` instead? You can do this by adding a `:` and then following up with an array that holds the information.

```surql
CREATE resident_of:['Toria', 'Aeon'];
CREATE resident_of:['Toria', 'Mother of Aeon'];
```

**Response**

```surql
-------- Query --------
[
  {
    id: resident_of:['Toria', 'Aeon']
  }
]
-------- Query --------
[
  {
    id: resident_of:['Toria', 'Mother of Aeon']
  }
]
```

Note the difference between these two records. They contain the same information, but the latter object holds the information in the record ID itself.

Any fields inside a complex ID are accessible by using the `[]` (indexing) operator, as this example shows.

```surql
CREATE resident_of:['Toria', 'Aeon'];
CREATE resident_of:['Toria', 'Mother of Aeon'];
SELECT id[0] AS lives_in, id[1] AS name FROM resident_of;
```

**Response**

```surql
[
  {
    lives_in: 'Toria',
    name: 'Aeon'
  },
  {
    lives_in: 'Toria',
    name: 'Mother of Aeon'
  }
]
```

One common reason to use complex record IDs is that SurrealDB's range operator works on record IDs. And selecting from a range of record IDs is extremely fast, because the database can look for only the records inside of this range instead of looking through the whole table.

This operator is written using `..` for an exclusive range (up to but not including the end of the range), and `..=` for an inclusive range (up to and including the end of the range).

Here is a quick example of this in practice. The following queries create some events that happened in the books in order, for both Aeon and Aeon's cat, and then uses a few `SELECT` statements with some of the possible ways to use the range operator. Note that a range query even works without specifying the end of the range, in which case it will be an open-ended range query.

```surql
CREATE book_event:['Aeon', 0]
  SET content = 'Aeon hears about some books';
CREATE book_event:['Aeon', 1]
  SET content = 'Aeon discovers the tunnel';
CREATE book_event:['Aeon', 2]
  SET content = 'Aeon sees a computer for the first time';
CREATE book_event:["Aeon's cat", 0]
  SET content = 'Eats some chicken';
CREATE book_event:["Aeon's cat", 1]
  SET content = 'Sleeps';
CREATE book_event:["Aeon's cat", 2]
  SET content = 'Tired from all the sleeping so gets some more sleep';
// All events for Aeon from 1 to but not including 10
SELECT VALUE content
  FROM book_event:['Aeon', 1]..['Aeon', 10];
// All events for Aeon from 0 up to and including 2
SELECT VALUE content
  FROM book_event:['Aeon', 0]..=['Aeon', 2];
// Open-ended: all of the events for Aeon's cat
SELECT VALUE content
  FROM book_event:["Aeon's cat", 0]..;
// All events for characters beginning with B and above
// (Therefore no events)
SELECT VALUE content
  FROM book_event:["B", 0]..;
// All events from the beginning up to Aeon's first event
// Nothing is lower than NONE, so NONE can be used as the start
// of a range
SELECT VALUE content
  FROM book_event:[NONE, NONE]..=['Aeon', 0];
// All events
SELECT VALUE content
  FROM book_event:[NONE, NONE]..;
// Another way of writing the same query
// `..` is open-ended, so no value is greater.
// `..` is the opposite of `NONE`
SELECT VALUE content
  FROM book_event:[NONE, NONE]..=[.., ..];
```

**Response**

```surql
-------- Query --------
[
  'Aeon discovers the tunnel',
  'Aeon sees a computer for the first time'
]
-------- Query --------
[
  'Aeon hears about some books',
  'Aeon discovers the tunnel',
  'Aeon sees a computer for the first time'
]
-------- Query --------
[
  'Eats some chicken',
  'Sleeps',
  'Tired from all the sleeping so gets some more sleep'
]
-------- Query --------
[]
-------- Query --------
[
  'Aeon hears about some books'
]
-------- Query --------
[
  'Aeon hears about some books',
  'Aeon discovers the tunnel',
  'Aeon sees a computer for the first time',
  'Eats some chicken',
  'Sleeps'
]
```

How record ranges work internally is a bit of a long discussion that we will get to in Chapter 10.

SurrealDB's range syntax also works to construct a range of integers, which can be quite convenient. Here is a quick example of a range used to check a value.

```surql
// Two bool checks
RETURN 5 >= 0 AND 5 <= 10;
// Or just use a range
RETURN 5 IN 0..=10;
```

Both queries return `true`.

A range can also be a nice way to quickly construct an array. To do so, just use `<array>` to perform the cast.

```surql
-- An array from 0 to 3, not including 4
RETURN <array>0..4;
-- Get the item at index 30 from this array
RETURN (<array>50..1000)[30];
```

**Response**

```surql
-------- Query --------
[
  0,
  1,
  2,
  3
]
-------- Query --------
80
```

## The `NULL` and `NONE` types

In the previous section we created one town with a random ID, as well as three others with complex record IDs. What happens if we try to select the `name` field of a record that doesn't have these fields? Will SurrealDB just return an error?

It will not. Instead, the records that don't have a `name` field will show `NONE` in its place.

```surql
CREATE town SET name = 'Sukh';
// typo: 'nnname' instead of 'name'
CREATE town SET nnname = 'Black Bay';
SELECT name, id FROM town;
```

**Response**

```surql
[
  {
    id: town:gnmn208kzt698l9r7kz0,
    name: NONE
  },
  {
    id: town:mkm7pspbq6arprxgu31h,
    name: 'Sukh'
  }
]
```

If you have used SQL before, you might be wondering why the output is `NONE` and not `NULL`. The answer is that SurrealDB does indeed have the type `NULL` to represent data that doesn't exist, but the two types represent a lack of data in a different way.

The behaviour of `NULL` is also different from `NULL` in SQL. For example, a `NULL` in SQL is not equal to itself, but is in SurrealQL:

```surql
RETURN null = null;
-- true
```

Rows containing NULL in SQL cannot be compared to each other, but can be in SurrealQL:

```surql
RETURN [null, 1] = [null, 1];
-- true
```

And some databases return `NULL` when dividing by zero in order to represent an error, which is not the case in SurrealDB.

```surql
RETURN 1000 / 0;
```

**Response**

```surql
NaN
```

So what is the exact definition of null in SurrealDB?

- `NULL` is a field that exists (a field that is "set"), but has no value.

- `NONE` is for a field that does not exist at all. In other words, setting a field to `NONE` removes the field from the record.

This difference is pretty easy to show. Let's start by creating another town close to Toria called The Hill:

```surql
CREATE town:the_hill SET name = "The Hill";
```

**Response**

```surql
[
  {
    id: town:the_hill,
    name: 'The Hill'
  }
]
```

And then give it a population.

```surql
CREATE town:the_hill SET name = "The Hill";
UPDATE town:the_hill SET population = 1125;
```

**Response**

```surql
[
  {
    id: town:the_hill,
    name: 'The Hill',
    population: 1125
  }
]
```

So far so good! Now let's see what happens when we set this new field to `null`.

```surql
CREATE town:the_hill SET name = "The Hill";
UPDATE town:the_hill SET population = 1125;
UPDATE town:the_hill SET population = null;
```

**Response**

```surql
[
  {
    id: town:the_hill,
    name: 'The Hill',
    population: NULL
  }
]
```

Did you notice that the `population` field is still showing up? That's because it was set to `NULL`, so it is still set, but has no value.

We can completely remove it by setting it to `NONE`:

```surql
CREATE town:the_hill SET name = "The Hill";
UPDATE town:the_hill SET population = 1125;
UPDATE town:the_hill SET population = NONE;
```

The output from the `UPDATE` statement shows that the `population` field does not show up, because it doesn't exist in any of the `town` records anymore.

**Response**

```surql
[
  {
    id: town:the_hill,
    name: 'The Hill'
  }
]
```

SurrealDB also has an `UNSET` keyword that is the same as setting a field to `NONE`. Using `UNSET` can be convenient when you need to remove a lot of fields at the same time.

```surql
CREATE town:the_hill SET
  name = "The Hill",
  population = 1125;
UPDATE town UNSET name, population;
```

**Response**

```surql
[
  {
    id: town:the_hill
  }
]
```

We learned a lot in this chapter! It's almost time for us to learn the `DELETE` keyword, but Aeon is still too afraid to try it out. Looks like we will have to wait until the next chapter to do so.

Practice time

```surql
SELECT name, surname, name + ' ' + surname FROM {
    name: "Bob",
    surname: "Bobson"
};
```

**Response**

```surql
[
  {
    name: 'Bob',
    "name + ' ' + surname": 'Bob Bobson',
    surname: 'Bobson'
  }
]
```

Answer

As the `name + '' + surname` part is clearly constructing a full name, we can add `AS full_name` to give it an alias.

```surql
SELECT name, surname, name + ' ' + surname AS full_name FROM {
    name: "Bob",
    surname: "Bobson"
};
```

**Response**

```surql
[
  {
    full_name: 'Bob Bobson',
    name: 'Bob',
    surname: 'Bobson'
  }
]
```

Just be sure not to give it an alias like `name`, as that will cause the original `name` field to not show up.

```surql
SELECT name, surname, name + ' ' + surname AS name FROM {
    name: "Bob",
    surname: "Bobson"
};
```

**Response**

```surql
[
  {
    name: 'Bob Bobson',
    surname: 'Bobson'
  }
]
```

### 2. What keyword would you use if you want to CREATE a record that you think might already exist?

Answer

You can use an `UPSERT` statement in this case.

```surql
CREATE person:aeon SET name = "Aeon", has_airplane = false;
UPSERT person:aeon SET name = "Aeon", money = 10;
```

Note that `UPSERT` doesn't have the option to add complex logic when a record already exists, but there is another statement called `INSERT` coming up in Chapter 7 that does.

### 3. How would you find every one of these towns with a population between 2000 and 9000?

```surql
CREATE town SET name = "Toria",     population = 20685, terrain = "Harbour";
CREATE town SET name = "Sukh",      population = 2955,  terrain = "Harbour"
CREATE town SET name = "Black Bay", population = 4137,  terrain = "Harbour",
CREATE town SET name = "Honeymoon", population = 200,   terrain = "Inland";
```

Answer

A `WHERE` clause will do the trick. You can use the keyword `AND` to add a second condition.

```surql
SELECT * FROM town WHERE population > 2000 AND population < 9000;
```

Or you can create a range to do the same check.

```surql
SELECT * FROM town WHERE population IN 2000..9000;
```

### 4. What if you wanted to have the `terrain` and `name` properties of those towns as part of the record ID itself? How would you create them?

Answer

You can put them inside an array that you can use `:` to join to the table name.

```surql
CREATE town:["Harbour", "Toria"] SET population = 20685;
CREATE town:["Harbour", "Sukh"] SET population = 2955;
CREATE town:["Harbour", "Black Bay"] SET population = 4137;
CREATE town:["Inland", "Honeymoon"] SET population = 200;
```

### 5. How would you then return all harbour towns whose `name` is greater than the value "M"?

Answer

You could use a `WHERE` clause on both `id[0]` and `id[1]`, or on a range of arrays between `["Harbour", "M"]` and `["Harbour", ..]`.

```surql
SELECT * FROM town WHERE id[0] = "Harbour" AND id[1] > "M";
SELECT * FROM town:["Harbour", "M"]..["Harbour", ..];
```

The range operator syntax will be more efficient than `WHERE`, because `WHERE` uses a whole table scan.
