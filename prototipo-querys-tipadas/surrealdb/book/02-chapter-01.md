# Chapter 1: One year later

**Time elapsed: 0**

> *It has been a long year, but a most satisfying one. You and your team have spent every day with these "computers" and now understand how they work. They are each capable of holding thousands, even millions of books. The area outside the tunnel now has a small settlement where you, your team, and a few villagers live. There are rooms inside the tunnel, but you still prefer to sleep outside in the traditional style of house you grew up in.*

> *One mystery remains: if computers are able to hold so much information, why don't any of your computers have it? Each computer has "software" that lets you accomplish tasks, but there isn't a single bit of information about the old world in any of them. All the information from the old world comes from the books in the tunnel.*

> *One of the types of software is called a database, which can store and retrieve information. This has given you a great idea. Why not store the information from the books in a database? This will make the information easy to find, and that quick access to information will help restore the old world to its former glory.*

> *It looks like the old world preferred a database called SurrealDB to store and manage most of its data. All you have to do now is learn how to use it...*

## Getting started with SurrealDB

In this book we will be using SurrealDB for tasks similar to the ones encountered by Aeon, and looks like it's time to get started.

The absolute simplest way to get started with SurrealDB is by using [the SurrealDB Studio app](https://studio.surrealdb.com/) online. Just going to that website will open up a blank sandbox for you to explore and start playing with data.

### Connecting via SurrealDB Cloud

While SurrealDB the database still exists in Aeon's time, the company SurrealDB is long gone. In fact, every single company from the 21st century is long gone too. That means that Aeon doesn't have the option to connect using the [SurrealDB Cloud](/cloud) - but we do! Using this will feel sort of like using the Sandbox, except that your schema and data will be stored so that it is there for you every time you log in.

You can use an email address or Google / GitHub account to sign up, just like on many other websites. Once this is done, click on `Create instance`, give it a name, choose a region that is close to you, then click on `Free instance` to get your own instance for free. Once it is created, you can click on `Connect` and `Open in SurrealDB Studio`. Finally, choose anything you like for the namespace and database name. We will learn about namespaces and databases in more detail in Chapter 9, but for the time being you can just remember that a namespace is a space that can hold multiple databases.

One nice thing about having a SurrealDB Cloud account is that it gives access to a free instance on SurrealDB Cloud which is limited only by having a storage limitation of 1 GB and a smaller compute node size. But besides that, it is free for you to use forever.

Installing SurrealDB locally is pretty easy too, so let's see how that works.

### Installing, starting and connecting to SurrealDB

Installation can be done in a terminal [with a single command](/docs/self-hosted/installation), whether on Windows, Linux, or macOS. Once this is done, you can start a database with the [surreal start](/docs/reference/cli/surrealdb-cli/commands/start) command.

The quickest way to start an in-memory database server is the `surreal start` command all on its own.

```surql
surreal start
```

The output after this command is fairly short.

```surql
2025-01-09T01:08:24.816048Z  INFO surrealdb::core::kvs::ds: Starting kvs store in memory
2025-01-09T01:08:24.816228Z  INFO surrealdb::core::kvs::ds: Started kvs store in memory
2025-01-09T01:08:24.824516Z  INFO surrealdb::net: Listening for a system shutdown signal.
2025-01-09T01:08:24.824518Z  INFO surrealdb::net: Started web server on 127.0.0.1:8000
```

But we can already see two important details in the output:

- The default address that SurrealDB will choose is 127.0.0.1:8000, and

- The default storage option is "in memory". No information will be saved once the database is shut down.

You can add arguments to the command as well, all of which can be seen by adding `--help` to the end of any command or subcommand. For example, `surreal --help` shows that you can use commands like `surreal start` and `surreal version`, while `surreal start --help` shows all the flags available under the `surreal start` command. Each command also has its own documentation page, such as [this page for the `surreal start` command](/docs/reference/cli/surrealdb-cli/commands/start).

But `surreal start` alone won't give you permission to do anything, because you won't be logged in as an authorised user. This is easy to fix though, by adding `--user` and `--pass` to create a user and a password when the database starts up.

```surql
surreal start --user root --pass secret
```

This will create a single user with root privileges (the ability to do anything at all).

Alternatively, you can also pass in the `--unauthenticated` flag which tells SurrealDB to allow anyone to do anything they like on the database. You'll see a warning when starting up in this case that this mode is not intended for production use.

```surql
surreal start --unauthenticated
```

Another flag, `--bind`, lets us change the address for the server. Here is an example of that:

```surql
surreal start --user root --pass secret --bind 127.0.0.1:8080
```

Once this is done, you can use the [SurrealDB Studio](https://studio.surrealdb.com/) app to begin making some queries through your running database.

Click on Create Connection, type `localhost:8000` for the connection, and then choose anything you like for the namespace and database name. And because the `surreal start` command above specified `root` as both the username and password, you can type `root` in both the `Username` and `Password` fields to complete the connection.

### Just using the SurrealDB Studio sandbox

Now that we know the basics of how to install, run, and connect to SurrealDB, let's get back to the quickest method: the SurrealDB Studio sandbox.

To use it, you can simply click on Open Sandbox instead of Create Connection. This will create an in-memory database that you can experiment with and which will lose its data once you close the tab.

There is also a desktop version of SurrealDB Studio available which adds extra functionality, such as the same database serving that we just saw with the `surreal start` command. We'll learn more about this much later, in Chapter 14.

One nice convenience inside the SurrealDB Studio sandbox is the ability to reset the sandbox environment with a single click of the "Reset sandbox environment" button. This will delete all of the database data and settings. This book has a lot of small sections with sample queries that aren't meant to be kept for the long term, so you'll probably end up using this button a lot when moving to a new concept that assumes that you are working with an empty database.

With that out of the way, let's get to the queries!

## Basic queries

Once your session has begun, it's time to start with some extremely basic queries. You can run queries inside SurrealDB Studio by clicking on the Run query button, or by pressing Ctrl and Enter together (which is much faster).

The most basic query of all uses the keyword `RETURN` (or `return`, or `ReTuRN` or anything else, because SurrealDB keywords are case insensitive). As the name suggests, this keyword simply returns the value that follows it. Let's give it a try with an integer.

```surql
RETURN 9;
```

**Response**

```surql
9
```

That's easy!

In fact, you don't even need to use the `RETURN` keyword. If you type 9 and hit enter, you'll get the same result. But adding `RETURN` tends to make code more readable so we will include it in the samples you see here.

Now let's try a string, which in SurrealDB can be enclosed in single or double quotes. Strings in SurrealDB can contain Unicode values, emojis, and tabular and multiline breaks.

So there are no problems with displaying the following emoji-filled string:

```surql
RETURN "Aeon rode on a 🐎 to get to the 🗻.";
```

**Response**

```surql
'Aeon rode on a 🐎 to get to the 🗻.'
```

Or a multiline string:

```surql
RETURN "Aeon
rode
on
a
🐎.";
```

**Response**

```surql
'Aeon
rode
on
a
🐎.'
```

Or a string with a tab:

```surql
RETURN "Aeon rode on a \t" + "🐎.";
```

**Response**

```surql
'Aeon rode on a    🐎.'
```

Values can be added to each other before they are returned:

```surql
RETURN "Aeon owns " + "9 horses.";
RETURN 9.5 + 9;
```

**Response**

```surql
-------- Query --------
'Aeon owns 9 horses.'
-------- Query --------
18.5f
```

But this next query won't work because SurrealDB is strongly typed and will refuse to add an integer to a string.

```surql
RETURN "Aeon owns " + 9 + " horses.";
```

**Response**

```surql
"Cannot perform addition with 'Aeon owns ' and '9'"
```

SurrealDB can't tell what you are trying to do here. Should the output be a string that includes a "9" inside? Or are you asking it to try to treat "Aeon owns " as a number? Or something else?

We can fix this by forcing SurrealDB to change one type to another, which is known as "casting".

## Casting

Casting lets you turn one type into another. To cast a type into another type, just put the type name inside `<>` (angle brackets) to tell SurrealDB what type to change to. For example, typing `<string>` to the left of a number will turn a number into a string. Now our query will work:

```surql
RETURN "Aeon owns " + <string> 9 + " horses.";
```

**Response**

```surql
'Aeon rode on 9 horses.'
```

Casting will still fail when the input is invalid. So this query won't work:

```surql
RETURN <int>"nine" + 9;
```

**Response**

```surql
"Expected a int but cannot convert 'nine' into a int"
```

You can cast as many times as you like. The query below turns a string into an integer (perhaps we are checking that the string contains a well-formatted number), and then back into a string so it can be combined with the string on the right.

```surql
RETURN <string><int>"9" + " is a good number";
```

**Response**

```surql
'9 is a good number'
```

Since casting works from right to left, you can think of the above two casts as:

> Cast the string "9" into an integer and then into a string, and return that.

Or from left to right:

> Return a string which is cast from an integer, which is cast from the string value "9".

SurrealDB will refuse to cast from one type to another if any data would be lost.

```surql
RETURN <int>10.0;
RETURN <int>10.1;
```

**Response**

```surql
-------- Query --------
10
-------- Query --------
'Expected `int` but found a `10.1f`'
```

Note that the database has displayed this number as `10.1f` instead of just `10.1` so that we know that it is a float. If we hadn't cast the `10.0` into an int, it would have been returned as `10f`.

As both integers and floats are 64-bit binary types, they have a maximum and minimum size limit. Floats with a lot of numbers after the decimal point also become a bit imprecise compared to the decimal numbers that humans use. Here is a typical example of how a float eventually becomes imprecise after too many digits.

```surql
RETURN 8.8888888888888888;
```

The output is `8.88888888888889f`. Similarly, the following number that is too large will fail to parse:

```surql
RETURN 88888888888888888888;
```

**Response**

```surql
"Parse error: Failed to parse number: number too large to fit in target type
 --> [1:8]
  |
1 | RETURN 88888888888888888888;
  |        ^^^^^^^^^^^^^^^^^^^^"
```

For such cases, you can opt in to the `decimal` type which uses 128 bits for more precision and with a much larger maximum and minimum value. The best way to create a decimal is with the `dec` suffix after the number.

```surql
RETURN [8.888888888888888dec, 88888888888888888888dec];
```

**Response**

```surql
[
  8.88888888888888dec,
  88888888888888888888dec
]
```

So why did we use a `dec` suffix this time instead of a cast? We can find out by giving a cast a try to see what happens:

```surql
RETURN <decimal>88888888888888888888;
```

Here we see the same error as before:

```surql
"Parse error: Failed to parse number: number too large to fit in target type
 --> [1:17]
  |
1 | RETURN <decimal>88888888888888888888;
  |                 ^^^^^^^^^^^^^^^^^^^^"
```

Here is a quick way to sum up the difference between a cast and a suffix like `dec`.

- A cast is an instruction to the database to convert one type into another. SurrealDB will look at 88888888888888888888, try to turn it into an integer, and then cast it into a `decimal`. But the input in the above case is a number that is too large to be an integer, and thus only an error is returned.

- The `dec` suffix is an instruction *to the parser* to treat the input as a decimal, instead of the usual integer.

Similarly, the cast from a large imprecise float will simply take that imprecise float and turn it into a decimal.

```surql
-- Returns 8.88888888888889dec
RETURN <decimal>8.888888888888888;
```

So be sure to keep this order in mind when considering using a cast. SurrealDB also has some prefixes for other types that work in the same way - as instructions to the parser - that we will learn about in later chapters.

SurrealDB also has a `number` type, which internally can be an `int`, a `float`, or a `decimal`. This is the most flexible numeric type and a good choice if you think you might have to work with both integers and floats.

```surql
// Will fail as a cast to `int` will result in data loss
RETURN <int>(8.9 + 10);
// But a `number` can also be a float, so no problem
RETURN <number>(8.9 + 10);
```

**Response**

```surql
-------- Query --------
'Expected `int` but found a `18.9f`'
-------- Query --------
18.9f
```

SurrealDB will not eagerly convert a string into another type unless you tell it to, even if the format matches. This next example shows that SurrealDB will always treat something inside quotes as a string, even if it matches the format for a UUID, unless you tell it otherwise.

```surql
RETURN       '0191267e-102b-777c-8312-c290e1a2bb46';
RETURN <uuid>'0191267e-102b-777c-8312-c290e1a2bb46';
```

You will see a single letter in front of types that appear to be strings but are not, in order to make it clear which type they are.

```surql
'0191267e-102b-777c-8312-c290e1a2bb46'
u'0191267e-102b-777c-8312-c290e1a2bb46'
```

Casting works for the following data types:

- `array`

- `bool`

- `bytes`

- `datetime`

- `duration`

- `string`

- `number`, `int`, `float`, `decimal`

- `uuid`

- Record IDs

- literals

We will learn all of these types shortly, and there are other ways to convert from one type to another in SurrealDB too. But now let's get back to our simple queries!

## RETURN again

We can use `RETURN` to return more complex values too, such as an object composed of keys and values.

```surql
RETURN {
    name: "Aeon",
    age: 20,
    town: "Toria",
};
```

**Response**

```surql
{
  age: 20,
  name: 'Aeon',
  town: 'Toria'
}
```

The code above simply returned an object with a few fields and values: an `age` of 20, the `name` "Aeon", and a `town` called `"Toria"` which is where Aeon is from. Note that object keys automatically show up in alphabetical order, and not the order in which we typed them. This is important for being able to compare and order inside SurrealDB, a concept we will learn about in Chapter 10.

We can access the individual fields of an object by using the `.` operator. The next query is exactly the same as above, except that we will add a `.` and the name of one of the object's fields. Doing so will only return this field instead of the whole object. Let's give it a try:

```surql
RETURN {
    name: "Aeon",
    age: 20,
    town: "Toria",
}.town;
```

**Response**

```surql
'Toria'
```

So far so good. Now what if we wanted to return two fields from this object instead of just one? Adding a comma followed by another field name won't work:

```surql
RETURN {
    name: "Aeon",
    age: 20,
    town: "Toria",
}.town, age;
```

**Response**

```surql
"Parse error: Unexpected token ',' expected Eof"
```

It won't work because, as soon as we write `.town`, the query evaluates to a single `string` and there is nowhere left to go: a `string` can't have a field called `age`.

However, you can replace a single field with `{}` in order to give SurrealDB a structure to work from, and then the query will work. Let's give that a try.

```surql
RETURN {
    name: "Aeon",
    age: 20,
    town: "Toria"
}.{
    town,
    age
};
```

**Response**

```surql
{
  age: 20,
  town: 'Toria'
}
```

This type of operation is called "destructuring", because it takes the original structure (`name`, `age`, `town`) and pulls it apart. You can then choose to restructure it in your own way, in this case by choosing a new structure that only has the `age` and `town` fields.

Here is another example of destructuring, in which we take an object with an even more nested structure apart and return it as a simpler object with four fields. This can be done by choosing a name for the field and then giving the path, such as `town_name: town.name`, which creates a field called `town_name` that reaches into the `town` object in the original structure and then its `name` field.

```surql
RETURN {
    name: "Aeon",
    age: 20,
    town: {
        name: "Toria",
        population: 20685
    }
}.{
    name,
    age,
    town_name: town.name,
    town_population: town.population
};
```

**Response**

```surql
{
  age: 20,
  name: 'Aeon',
  town_name: 'Toria',
  town_population: 20685
}
```

So even a simple statement like `RETURN` can give some pretty interesting results! However, `RETURN` can't do anything but return the value that follows it. That means that you can't do something like this which uses the `WHERE` keyword to filter results based on a condition.

```surql
RETURN {
    name: "Aeon",
    age: 20,
    town: "Toria"
} WHERE name = "Aeon";
```

**Response**

```surql
"Parse error: Unexpected token `WHERE`, expected Eof
 --> [5:3]
  |
5 | } WHERE name = \"Aeon\";
  |   ^^^^^"
```

Plus, `RETURN` on its own doesn't actually query any records in a database - it just returns the value that follows it.

To make actual queries on a database, we'll need to learn the next keyword: `SELECT`.

## SELECT

`RETURN` was the easiest keyword for us to start with, but `RETURN` can't do anything more than return the value that follows it. Most of the time when doing a query you will use a `SELECT` statement.

`SELECT` has a more complex syntax than `RETURN`, and always requires the keyword `FROM`. Every time you use `SELECT` you are making the following decision:

- What do I want to select?

- And what do I want to select it from?

In one of our `RETURN` statements above, we wanted to take the object below and return its `town` and `age` fields. We did this by using a `.` and then the new structure that we wanted SurrealDB to return the data in.

```surql
RETURN {
    name: "Aeon",
    age: 20,
    town: "Toria",
}.{
    town,
    age
};
```

Let's try returning the same output inside a `SELECT` statement. To make it work, all we have to do is put those two field names in between `SELECT` and `FROM`.

```surql
SELECT town, age FROM {
    name: "Aeon",
    age: 20,
    town: "Toria",
};
```

**Response**

```surql
[
  {
    age: 20,
    town: 'Toria'
  }
]
```

Now what if we wanted to select everything, instead of typing `name, age, town`? In this case you can use a * instead of the names of an object's fields. This is known as the star operator.

```surql
SELECT * FROM {
    name: "Aeon",
    age: 20,
    town: "Toria",
};
```

**Response**

```surql
[
  {
    age: 20,
    name: 'Aeon',
    town: 'Toria'
  }
]
```

And if you want to select *almost* everything but omit one or more fields, you can use the `OMIT` keyword.

```surql
SELECT *
    OMIT boring_data,
    who_cares,
    uninteresting_data
FROM {
    name: "Aeon",
    age: 20,
    town: "Toria",
    boring_data: true,
    who_cares: 888.9,
    uninteresting_data: "Bunch of data"
};
```

**Response**

```surql
[
  {
    age: 20,
    name: 'Aeon',
    town: 'Toria'
  }
]
```

## Using INFO to see info about the database

We now know the basics of querying in SurrealDB, but so far we have only been `RETURN`ing and `SELECT`ing values that we created at the time of the query. That means that nothing has been stored in the database yet!

We can confirm this with a simple command using the `INFO` keyword. One of the ways the `INFO` keyword can be used is by typing `INFO FOR DB`, which will describe the makeup of a database.

```surql
INFO FOR DB;
```

You should see the following:

```surql
{
	accesses: {},
	analyzers: {},
	apis: {},
	buckets: {},
	configs: {},
	functions: {},
	models: {},
	params: {},
	sequences: {},
	tables: {},
	users: {}
}
```

There's nothing there! Our database hasn't stored anything yet, so there is nothing inside the `tables` field.

To actually insert information into the database, we will need to use the `CREATE` keyword.

## Using CREATE to create records

After `CREATE` you will need to add a table name, such as `person`, or `book`, or `City`. These names are case-sensitive, so a `city` and a `City` will be different.

When you use `CREATE`, SurrealDB will create what is known as a "record". You can tell that something is a record in SurrealDB, because it will have a field called `id`. Let's give it a try!

```surql
CREATE person;
```

**Response**

```surql
[
    {
        id: person:wr1jj2aoiyho0nfp9kk6
    }
]
```

We didn't give this `person` any fields such as `name`, `age`, or anything else, but SurrealDB will still create a record ID for it. SurrealDB uses a random [20-character ID](/docs/reference/query-language/functions/database-functions/rand#randid) by default for record IDs.

Typing `CREATE person` again would then create another `person` with its own unique ID. All record IDs in SurrealDB are composed of the table name, a `:` (a colon), and a value that follows. You can choose your own ID instead of a random one, but keep in mind that every record ID must be unique. So if you were to type `CREATE person:one` twice, the first query would work but the second query would return an error, because there can only be one `person:one`.

If we have a record in the database, we can use `SELECT` to see it and every field inside.

```surql
CREATE person;
SELECT * FROM person;
```

**Response**

```surql
[
    {
        id: person:wr1jj2aoiyho0nfp9kk6
    }
]
```

Though only a single record was returned, note that it is still enclosed inside `[]`. So the return value is not a single record, it's *an array that contains a single record*. There could easily have been more than one `person` record returned from such a query.

One way to create multiple records at the same time (out of many, many other ways to do so) is by simply using a comma between each one.

```surql
CREATE person, person:aeon, cat:aeons_cat;
```

**Response**

```surql
[
  {
    id: person:ro3qtpqle7e38k91rx3y
  },
  {
    id: person:aeon
  },
  {
    id: cat:aeons_cat
  }
]
```

## Setting fields with SET and CONTENT

To add more to a new record than just its ID, you can use `SET` to set its fields. This can be done by writing the field name, `=`, and its value.

```surql
CREATE person SET
    name = "Aeon",
    town = "Toria";
```

**Response**

```surql
[
  {
    id: person:fprkouzc7v9l1iepywlm,
    name: 'Aeon',
    town: 'Toria'
  }
]
```

Alternatively, you can choose the `CONTENT` keyword here if you have an object with keys and values that you want to pass in.

```surql
CREATE person CONTENT {
    town: "Toria",
    name: 0.5
};
```

**Response**

```surql
[
  {
    id: person:kobnrcl77mwbb2mysj7q,
    name: 0.5f,
    town: 'Toria'
  }
]
```

That's convenient. But hold on, why did SurrealDB let us set 0.5 (a float) for a person's name?

## Databases have no schema until you make one

Let's take a look at the three `person` records that we created above.

```surql
SELECT * FROM person;
```

**Response**

```surql
[
    {
        id: person:0wyyfsc3v09gbaqczjwc,
        name: 0.5f,
        town: 'Toria'
    },
    {
        id: person:pjb4v5xmcv6gig2m59us
    },
    {
        id: person:xathn24hfwcuk3cw4dxw,
        name: 'Aeon',
        town: 'Toria'
    }
]
```

They are all quite different. One has a float for its `name` field, another has a string, and the record in the middle only has an id. Does SurrealDB just let a field be anything you want?

The answer is yes, but also no. The short explanation is that SurrealDB is permissive by default, but also as strict as you want it to be.

We can use the `INFO FOR DB` command again to try to get some insight here.

```surql
INFO FOR DB;
```

**Response**

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

Ah ha! A table called `person` has been automatically defined, but it is `SCHEMALESS` - it has no schema.

A schema is the way for you to strictly define your data and make it behave in ways that you expect.

If we had defined a schema for the `person` table, we would have been able to specify that `town` must be a `string`, that the `town` field is optional, that a `town` name can be no longer than 50 characters in length, and so on. In that case, the `CREATE` for the second record above would not have worked.

The `PERMISSIONS NONE` part of the table declaration above means that no operations (such as `SELECT`) are permitted. This doesn't affect us, because as a root user we are an exception to permissions rules. But by default nobody else can perform any operations unless we allow them to.

The `TYPE ANY` part of the table declaration above means that the table can be used either as a regular record, or a record that connects one record to another.

We will encounter `DEFINE TABLE` and `TYPE ANY` again in Chapter 5, and will practice permissions in Chapter 15. But for the time being, just remember that SurrealDB is as flexible as possible by default, but also as strict as you want it to be.

## Other ways to use SurrealDB

We'll finish up this first chapter with a few other ways you could use SurrealDB. While SurrealDB Studio is the easiest (and prettiest) way to query our database, SurrealDB is still just a regular database sitting at an address like `http://localhost:8000`, and that means that there are many ways to communicate with it.

For example, you could send raw requests using curl (curl.exe for Windows) at the `/sql` endpoint, or through some other piece of software like [Postman](/docs/explore/tutorials/tutorials/http-via-postman). Here is a simple example with curl:

```surql
curl -X POST \
  -u "root:root" \
  -H "surreal-NS: mynamespace" \
  -H "surreal-DB: mydatabase" \
  -H "Accept: application/json" \
  -d 'CREATE person SET name = "Aeon";' \
  http://localhost:8000/sql
```

Another option is to use the [surreal sql](/docs/reference/cli/surrealdb-cli/commands/sql) command, which starts a REPL on the command line. The following command will open up a simple CLI that you can use to make queries.

```surql
surreal sql
```

The output is much less flashy than SurrealDB Studio, but does the job:

```surql
main/main> CREATE person SET name = "Aeon";
```

**Response**

```surql
[[{ id: person:i1xkrz7tytx7rs2v657c, name: 'Aeon' }]]
```

You can also pass in the `--pretty` flag to make the output more similar to what you see inside SurrealDB Studio. Here is the output from the previous query when pretty output is used.

```surql
-- Query 1 (execution time: 8.3331ms)
[
    {
        id: person:i1xkrz7tytx7rs2v657c,
        name: 'Aeon'
    }
]
```

The `surreal sql` command is especially useful when connecting to a remote server and you only have access to the command line.

Practice time

### 1. Does the output of the following query have a record ID?

```surql
SELECT * FROM {
name: "Billy",
age: 10
};
```

Answer

A: No, because the query simply returns the object passed in to the query and does not `SELECT` from any tables in the database.

```surql
[
  {
    age: 10,
    name: 'Billy'
  }
]
```

### 2. How could you change this query to only return the value of the 'possible_population' field?

```surql
RETURN {
town_name: "Toria",
year: "?????",
possible_population: 20685
};
```

Answer

You can add `.possible_population` after the object:

```surql
RETURN {
    town_name: "Toria",
    year: "?????",
    possible_population: 20685
}.possible_population;
```

**Response**

```surql
20685
```

### 3. How could you change this query to only return the `possible_population` field, but as a new field name called `population`?

This one is a bit of a challenge question. See if you can make it work!

```surql
RETURN {
town_name: "Toria",
year: "?????",
possible_population: 20685
};
```

Answer

You can use `.` to access the whole object (destructuring) and then specify the new structure. In this case, it will be a single field that has the name `population` that goes to the original `possible_population` to get its value.

```surql
RETURN {
    town_name: "Toria",
    year: "?????",
    possible_population: 20685
}.{
    population: possible_population
};
```

**Response**

```surql
{
  population: 20685
}
```

### 4. How do you select certain fields from a record, and how do you select all of its fields?

Take the following record:

```surql
CREATE conditions SET
weather_type = "windy",
temperature = -0.1,
humidity = 27.5;
```

Answer

To return only `temperature` and `humidity`, name those fields in `SELECT`:

```surql
SELECT temperature, humidity FROM conditions;
```

**Response**

```surql
[
  {
    humidity: 27.5f,
    temperature: -0.1f
  }
]
```

To return every field, use `*`:

```surql
SELECT * FROM conditions;
```

**Response**

```surql
[
  {
    humidity: 27.5f,
    id: conditions:cbqk4ijtogszjueesni6,
    temperature: -0.1f,
    weather_type: 'windy'
  }
]
```

### 5. How would you select the name, location, population, and type fields from the object below?

Here is the object to select from.

```surql
{
name: "Toria",
location: "Southern tip of the island",
population: 20685,
nearest_neighbor: "Sukh",
type: "city"
}
```

Answer

You could type `SELECT name, location, population, type`, but using the `OMIT` keyword in this case is shorter.

```surql
SELECT * OMIT nearest_neighbor FROM {
    name: "Toria",
    location: "Southern tip of the island",
    population: 20685,
    nearest_neighbor: "Sukh",
    type: "city"
};
```

You can decide which of the two to use based on readability.

### 6. How would you return the `population` field from the same object as a string instead of a number?

Answer

A number can always be cast into a string, so adding `<string>` will do the trick.

```surql
SELECT * OMIT nearest_neighbor FROM {
    name: "Toria",
    location: "Southern tip of the island",
    population: <string>20685,
    nearest_neighbor: "Sukh",
    type: "city"
};
```
