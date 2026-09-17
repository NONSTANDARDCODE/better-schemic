# Chapter 4: The security door

**Time elapsed: 1w**

> *The technology of the ancient world continues to amaze you. Today, you discovered another room with its own set of computers that have nothing to do with collecting data. These computers are used for security. One of their security features is the ability to close the entrance to the whole compound for a set period of time.*

> *Strangely enough, there is no option to close the security door permanently. The longest durations it will accept are up to 24 hours, up to 7 days, up to 52 weeks, up to 100 years... or the maximum value, one "age". An "age" must be longer than a century, but how long is it actually? You're curious, but there's no way that you'll ever need to select that option.*

> *The shorter durations could be useful if you need to leave the compound for a while and don't want people to touch the books or computers. After all, only you and your team understand their true value. You often think about how best to present this new knowledge to the world once you have learned to properly use a database. Will the sudden rediscovery of the knowledge of the ancient world please them, or will they be afraid of it?*

> *And maybe the formula in that grey book will come in handy one day? Its "humanity hope ratio" sounds like a good thing to know if you can ever figure it out.*

> *In the meantime, it's time to gather your courage and learn how to delete records.*

## The DELETE keyword

### DELETE on its own deletes everything

Aeon's caution about deleting records is understandable, because by default the `DELETE` keyword followed by a table name will delete each and every record.

Let's give this a try! First, let's create a large number of `person` records without any fields. We'll go with fifty of them.

```surql
CREATE |person:50| RETURN NONE;
```

**Response**

```surql
[]
```

We can prove that there are 50 `person` records with the following query that uses the `count()` function, which counts the number of items it receives.

```surql
RETURN count(SELECT * FROM person);
```

**Response**

```surql
50
```

Now let's try deleting them all! We will also run a `SELECT` after the deletion to make sure that the `person` records are all gone.

```surql
CREATE |person:50| RETURN NONE;
DELETE person;
SELECT * FROM person;
```

**Response**

```surql
[]
```

That was quick.

### Using WHERE in a DELETE statement

You can use the `WHERE` clause in a `DELETE` statement to ensure that you don't delete each and every record for a table. The syntax is not very surprising. Here are two quick examples:

```surql
DELETE person WHERE name = 'Aeon';
DELETE person
  WHERE name = 'Aeon' AND town = 'Toria';
```

When deleting large amounts of data, you might want to confirm that your `WHERE` statement is working as you expect in order to avoid any unpleasant surprises caused by human error. For example, imagine that we created a lot of `person` records that use the `rand::int()` function to give each one a random integer.

```surql
CREATE |person:50| SET num = rand::int();
```

Later on, we decide that we want to delete the ones that have a `num` that is negative. A `WHERE num < 0` should do it. But if we have a typo in our `DELETE` statement...

```surql
CREATE |person:50| SET num = rand::int() RETURN NONE;
-- Whoops, forgot the '< 0' part!
DELETE person WHERE num;
SELECT * FROM person;
```

**Response to SELECT statement**

```surql
[]
```

The `DELETE person WHERE num` statement evaluates to "delete any `person` record that has a value at the field `num`". In other words, all of them.

A bit of first playing around with the output by using `SELECT` instead of `DELETE` will let you delete with confidence.

```surql
CREATE |person:50| SET num = rand::int() RETURN NONE;
// Now see how many there are
RETURN count(SELECT * FROM person);
// Will this delete about half of them?
RETURN count(SELECT * FROM person WHERE num);
// Oops! Try the WHERE clause again
RETURN count(SELECT * FROM person WHERE num < 0);
// Looks good, now change SELECT * FROM to DELETE
DELETE person WHERE num < 0;
```

One other way to avoid mistakes with `DELETE` is by returning the records that were deleted.

### Returning BEFORE, AFTER, and more

A lot of operations in SurrealDB involve a change of state: using `CREATE` to make new records, `UPDATE` to change them, `DELETE` to remove them, and so on. By default, these operations return the result *after* the query is completed.

Since a `DELETE` query eliminates existing records, that means that it returns nothing (an empty array).

But sometimes we will want to return the state before a query was completed, especially when using `UPDATE` and `DELETE`. SurrealDB offers this convenience via the `RETURN BEFORE` and `RETURN AFTER` clauses.

Let's try this by creating Aeon again, after which Aeon will be updated with a `town`. However, inside the `UPDATE` we will instruct SurrealDB to return the `BEFORE` state of the query: the `person` before the `town` field was given a value.

```surql
CREATE person SET name = 'Aeon';
UPDATE person SET town = 'Toria' RETURN BEFORE;
```

**Response to UPDATE statement**

```surql
[
    {
        id: person:7ykci42eb08vszvcur2t,
        name: 'Aeon'
    }
]
```

You can also choose to `RETURN DIFF`, which returns the changes performed to turn the data from its previous state to its current state. This is one of the nice ways (among others) to keep track of what is going on with your data instead of just using queries to view the final results.

```surql
CREATE person SET name = 'Aeon';
UPDATE person SET town = 'Toria';
UPDATE person SET age = 20, fears_delete = true RETURN DIFF;
UPDATE person UNSET age RETURN DIFF;
```

**Response to DIFF statements**

```surql
-------- Query --------
[
  [
    {
      op: 'add',
      path: '/age',
      value: 20
    },
    {
      op: 'add',
      path: '/fears_delete',
      value: true
    }
  ]
]
-------- Query --------
[
  [
    {
      op: 'remove',
      path: '/age'
    }
  ]
]
```

This output is in a format known as a [JSON patch](https://jsonpatch.com/).

The keywords `BEFORE` and `AFTER` are accessed in a pretty interesting way. Learning about how that works will teach us something new about how statements are processed in SurrealDB.

### Using `$before`, `$after`, and other statement values

The keywords `BEFORE` and `AFTER` are a nice convenience, but you can't use both at the same time.

```surql
UPDATE person SET age = 20 RETURN BEFORE, AFTER;
```

**Response**

```surql
"There was a problem with the database: Parse error: Unexpected token `,`, expected Eof
 --> [1:46]
  |
1 | UPDATE person SET name = 'Aeon' RETURN BEFORE, AFTER;
  |                                              ^ 
"
```

Or can you? What if we make them lowercase and add a dollar sign in front of them?

```surql
UPDATE person SET age = 20 RETURN $before, $after;
```

**Response**

```surql
[
  {
    after: {
      age: 20,
      id: person:zf8dwubdw0efwnu46bbd,
      name: 'Aeon',
      town: 'Toria'
    },
    before: {
      id: person:zf8dwubdw0efwnu46bbd,
      name: 'Aeon',
      town: 'Toria'
    }
  }
]
```

So how did that work? It's not because every keyword has a lowercase dollar sign equivalent. What we've seen instead is our first example of SurrealDB's preset parameters.

Preset parameters are parameters that are set for any values that might be relevant to an operation. The `BEFORE` and `AFTER` keywords are simply a convenience to access either of these parameters.

You can also make your own parameters. Here are the first two things to know about them:

- Their names are case-sensitive, so typing `$BEFORE` or `$AfTeR` will not access `$before` or `$after`.

- You can make your own inside a query by using the `LET` keyword.

### Using the LET keyword to create parameters

Here's an example of using `LET` to create a parameter. We can make one called `$name` and then pass it into a `CREATE` statement.

```surql
LET $name = "Aeon";
CREATE person SET name = $name;
```

**Response**

```surql
[
    {
        id: person:7i82mzuy19z1uydkmqym,
        name: 'Aeon'
    }
]
```

For extra type safety and code readability, you can add a type declaration after `LET`. This lets you ensure that an expected type is correct instead of always needing to rely on your own eyes and mind.

Specifying a type makes it easier to avoid unexpected surprises. Take this parameter `$name` for example that we would like to be a string, but won't be. Can you guess what the error will be?

```surql
CREATE person SET name = "Aeon";
LET $name: string = SELECT name FROM person;
```

Instead of a string, we got an object inside an array which has a field that is a string.

**Response**

```surql
"Tried to set `$name`, but couldn't coerce value:
Expected `string` but found `[{ name: 'Aeon' }]`"
```

We learned the `VALUE` keyword recently. Maybe that will do the trick?

```surql
CREATE person SET name = "Aeon";
LET $name: string = SELECT VALUE name FROM person;
```

Closer, but not quite! This time we got an array of strings instead of a single string.

**Response**

```surql
"Tried to set `$name`, but couldn't coerce value:
Expected `string` but found `['Aeon']`"
```

We can finally get this `LET` statement to work by using `[0]` to access the first item of the output, which is indeed a string.

```surql
CREATE person SET name = "Aeon";
LET $name: string = (SELECT VALUE name FROM person)[0];
```

So just adding `: string` to the query saved us a lot of headaches down the line because the query is guaranteed to fail if the expected and received types do not match.

Now that we have the basics of parameters down, let's get back to SurrealDB's preset parameters.

### More preset statement parameters

Unseen to us, SurrealDB sets [quite a few other parameters](/docs/reference/query-language/language-primitives/parameters#reserved-variable-names) inside every statement. One example of these parameters is one called `$session` (more on this in Chapter 9) that is always available if you want to see your current session details. Let's take a look at what it returns inside the sandbox.

```surql
RETURN $session;
```

**Response**

```surql
{
  db: 'sandbox',
  exp: NONE,
  id: NONE,
  ip: NONE,
  ns: 'sandbox',
  or: NONE,
  sc: NONE,
  sd: NONE,
  tk: NONE
}
```

You can sort of imagine SurrealDB sneaking in a few `LET` statements every time you do an operation, depending on what is relevant. If irrelevant, a `NONE` will be returned instead.

For example, a `SELECT` statement doesn't modify data so there is no need to set `$before` and `$after`. That's why they always show up as `NONE` when using `SELECT`.

```surql
CREATE person;
SELECT $before, $after FROM person;
```

**Response**

```surql
[
  {
    after: NONE,
    before: NONE
  }
]
```

It's best to avoid using these parameter names in your own queries, as SurrealDB will point to a different value if the query sets one of these parameters during its operation.

```surql
CREATE person:aeon;
LET $before = "Before!";
DELETE person RETURN $before;
RETURN $before;
```

As `DELETE` sets `$before` to the value before deletion, it will not return the string "Before!", but `$before` will then evaluate to "Before!" again once the `DELETE` operation is over.

```surql
-------- Query --------
[
  {
    before: {
      id: person:aeon
    }
  }
]
-------- Query --------
'Before!'
```

And because a `SELECT` statement does not set the parameter `$before`, the string "Before!" will show up in all cases this time.

```surql
CREATE person:aeon;
LET $before = "Before!";
SELECT $before FROM person;
```

**Response**

```surql
[
  {
    before: 'Before!'
  }
]
```

In addition to this, some parameters such as `$session` are outright forbidden. This is because they are expected to be present inside any and all contexts.

```surql
LET $session = "Is this thing on?";
```

**Response**

```surql
"'session' is a protected variable and cannot be set"
```

In any case, avoiding these preset parameter names is highly recommended.

## FOR loops

Using what we know from the previous section, let's insert some towns again in order to practice deleting them.

```surql
CREATE town SET name = 'Toria',     population = 20685;
CREATE town SET name = 'Sukh',      population = 2955;
CREATE town SET name = 'Black Bay', population = 4137;
```

After this we changed our mind: a `town` should only be for places that have a population of at least 5000. Anything else should be a `village`. To delete only these records, we can just add `WHERE population < 5000` and we are done!

We'll add the `RETURN BEFORE` clause to the end to make sure that we can see the records that were deleted.

```surql
DELETE town WHERE population < 5000 RETURN BEFORE;
```

**Response**

```surql
[
    {
        id: town:eqe7g0uaotnbo52e5uie,
        name: 'Black Bay',
        population: 4137
    },
    {
        id: town:or2p68tfy84vujtjesnx,
        name: 'Sukh',
        population: 2955
    }
]
```

Being able to see the deleted objects is pretty nice, but now we have to manually recreate the town data.

So let's try a better approach. Instead of just deleting these two town records, we could store the data as another record type first, and then delete it. We could do this all at once inside a `FOR` loop, which takes an array of values and lets us decide what to do with each one.

To practice our first `FOR` loop, let's recreate the two towns that we deleted. It will take the following data, an array of objects.

```surql
[
  { name: "Black Bay", population: 4137 },
  { name: "Sukh", population: 2955 }
]
```

We can then tell SurrealDB to create one `town` for each of these objects.

```surql
FOR $data IN 
  [
    { name: "Black Bay", population: 4137 }, { name: "Sukh", population: 2955 }
  ] {
    CREATE town SET
      name = $data.name,
      population = $data.population;
};
```

Next, we want to select the towns with population under 5000, create a `village` record using their data, and then delete the `town` records holding their data. The query will be similar to the above, except that the `FOR` loop is taking the output of a `SELECT` statement, which returns an array.

```surql
FOR $t IN SELECT * FROM town WHERE population < 5000 {
    CREATE village SET
        name = $t.name,
        population = $t.population;
    DELETE $t;
};
SELECT * FROM town, village;
```

**Response**

```surql
[
  {
    id: town:xo5b77f7xmg00dt010z7,
    name: 'Toria',
    population: 20685
  },
  {
    id: village:pidm8yodrsyueaokda8z,
    name: 'Sukh',
    population: 2955
  },
  {
    id: village:qqlbbm1lta5xac2vgpsd,
    name: 'Black Bay',
    population: 4137
  }
]
```

So why did we choose the variable name `$t` instead of `$town`? Well, we didn't have to, and could have chosen to use `$town`. But if we had forgotten to add a $ to our query and written `town` instead of `$town`, then the following would have happened:

```surql
FOR $town IN SELECT * FROM town WHERE population < 5000 {
    CREATE village SET
        name = $town.name,
        population = $town.population;
    DELETE town; -- Whoops, deletes all `town` records!
};
```

That query would have left us with two `village` records, but no `town`!

The range syntax that we learned in the last chapter works with FOR loops too. Here is a quick example that creates `person` records that have a name equal to the number of each step of the loop.

```surql
FOR $num IN 1..=10 {
    CREATE person SET name = "Person number " + <string>$num;
};
```

The records created will have the name "Person number 1", "Person number 2", and so on.

## DELETE doesn't delete tables; REMOVE does

Deleting every record for a table doesn't remove the table itself. It would be most unfortunate if this were the case! You would have to make sure that every table defined in your database has at least one record to keep it from getting removed.

We can prove this behaviour with three quick queries. One creates a `town`, the next deletes them all, and the last gets the info for the current database which will hold information on the tables inside.

```surql
CREATE town;
DELETE town;
INFO FOR DB;
```

The output is not too surprising:

**Response**

```surql
{
    accesses: {},
    analyzers: {},
    apis: {},
    buckets: {},
    configs: {},
    functions: {},
    models: {},
    modules: {},
    params: {},
    sequences: {},
    tables: {
            town: 'DEFINE TABLE town TYPE ANY SCHEMALESS PERMISSIONS NONE'
    },
    users: {}
}
```

`REMOVE` will do the trick. It's a pretty straightforward statement: just the `REMOVE` keyword, followed by what you would like to remove (a `TABLE`, a `FIELD`, and so on), and its name. So this is all you need to remove the `town` table from the database:

```surql
CREATE town;
REMOVE TABLE town;
INFO FOR DB;
```

The `INFO FOR DB` command will now contain nothing.

**Response**

```surql
{
    accesses: {},
    analyzers: {},
    apis: {},
    buckets: {},
    configs: {},
    functions: {},
    models: {},
    modules: {},
    params: {},
    sequences: {},
    tables: {},
    users: {}
}
```

The syntax is the same when removing a field via a `REMOVE FIELD` statement, except that you will need to add the word `ON` and then the table name.

```surql
REMOVE FIELD name ON TABLE town;
```

## Record functions to find table names and IDs

Getting back to our data, we can do a quick `SELECT` to show that these two locations are now villages and not towns:

```surql
SELECT * FROM town, village;
```

**Response**

```surql
[
    {
        id: town:kcpphctxwiktsrscaoof,
        name: 'Toria',
        population: 20685
    },
    {
        id: village:90pgjnbdkrz5ar73vq45,
        name: 'Sukh',
        population: 2955
    },
    {
        id: village:rywz14k0y9x99bz6qd9c,
        name: 'Black Bay',
        population: 4137
    }
]
```

The output looks pretty good, but how can we make it easier to tell that an object returned is of one type and not another? SurrealDB has a function that can help called `record::tb()` which returns the table name of a record ID. Let's give it a try:

```surql
SELECT
    name,
    population,
    record::tb(id) AS type
FROM town, village;
```

**Response**

```surql
[
    {
        name: 'Toria',
        population: 20685,
        type: 'town'
    },
    {
        name: 'Sukh',
        population: 2955,
        type: 'village'
    },
    {
        name: 'Black Bay',
        population: 4137,
        type: 'village'
    }
]
```

There is also a function called `type::record()` that you can pass a table name and record ID into in order to make a record.

```surql
CREATE type::record("settlement", 1);
// id: settlement:1
CREATE type::record("settlement", "1");
// id: settlement:`1`
```

This function can be useful when you have the pieces of a record ID in some other format (like a string) that you want to turn into a record. For example, this query won't work:

```surql
FOR $name IN ["roman_god", "planet"] {
    CREATE $name:"jupiter";
};
```

While SurrealDB is able to parse an input like `CREATE roman_god:jupiter`, it doesn't know what to do with a string ("roman_god") followed by a colon (`:`), followed by a string ("jupiter") or a random word (jupiter).

But the `type::record()` function is able to take two inputs like these and turn them into a record.

```surql
FOR $name IN ["roman_god", "planet"] {
    CREATE type::record($name, "jupiter");
};
```

So how did we know that `record::tb()` and `type::record()` were available to use, and how many other functions are there? Let's take a look.

## Other functions

SurrealDB has an [extensive collection of functions](/docs/reference/query-language/functions/database-functions), too many for us to all mention in this book. But they are divided quite neatly into their own modules, which makes them easy to find.

Function names in SurrealDB are composed of one or more words joined by `::`, with a tendency towards longer function names when further grouping makes sense. This style of grouping also makes function names quite easy to read.

For example, there are a large number of `string::is` functions whose usage is pretty clear:

```surql
string::is_hexadecimal()
string::is_latitude()
string::is_ascii()
```

Let's give two of them a try! The `string::is_latitude()` function should return `true` for any latitude string between -90 and 90, and `string::is_longitude()` should do the same for any value between -180 and 180.

```surql
RETURN string::is_latitude("87.5519");
RETURN string::is_latitude("97.5519");
RETURN string::is_longitude("97.5519");
RETURN string::is_longitude("187.5519");
```

**Response**

```surql
true
false
true
false
```

Some function paths are longer if they represent a more specific kind of behaviour, such as sorting or the type of output.

```surql
array::sort()
array::sort::asc()
array::sort::desc()
rand::uuid()
rand::uuid::v4()
rand::uuid::v7()
```

Here are some other function names to give you an idea of the variety of functions available.

```surql
array::sort()
string::len()
string::semver::set::major()
value::diff()
rand::uuid::v7()
```

## Using method syntax for functions

One of the nice features in SurrealQL is the ability to use the `.` operator to call these functions as methods on a type, instead of the full paths we just saw.

What that means in practice is that you have the option of calling a function in two ways. You can use the full path, followed by the function argument(s):

```surql
-- Call a string method, pass in a string
RETURN string::is_latitude("87.5519");
```

Or you can use the same function called as a method on the type.

```surql
-- Have a string, call a method on it
RETURN "87.5519".is_latitude();
```

This syntax is particularly nice when it comes to method chaining. Method chaining is when you call a method on a value and can then call another method on what it returns, all in a single statement!

The following example in which we push the number 4 to the end of an array and then check the array's length looks much more readable using the new syntax.

```surql
-- Using regular function paths
RETURN array::len(array::push([1,2,3], 4));
-- Using method syntax
RETURN [1,2,3].push(4).len();
```

Which syntax to use is entirely up to you, and will depend on the situation. You might still prefer the full path of functions like `string::len()` and `array::len()` to make it clear to the reader of your code, as the example below shows.

```surql
LET $some_data = "Some data";
LET $some_other_data = [1,2,3];
--
-- Lots of lines of code...
--
-- Hmm, which one is the string, and which one is the array?
RETURN [$some_data.len(), $some_other_data.len()];
-- This makes it clear which one is which
RETURN [string::len($some_data), array::len($some_other_data)];
```

## Destructuring inside a query

Speaking of method syntax, let's take a look at one more function called [`object::entries()`](/docs/reference/query-language/functions/database-functions/object#objectentries), one of the functions available for the `object` type. This function transforms an object from a structured output with keys and values into an array, inside which are extra arrays that each hold the key and the value.

To show what this means in practice, let's try it on a simple object.

```surql
{
  name: "Aeon",
  age: 20
}.entries();
```

**Response**

```surql
[
  [ 'age', 20 ],
  [ 'name', 'Aeon' ]
]
```

Since SurrealDB returns records in an object format, we should be able to call this method on a town like `town:sukh` that we worked with in the last chapter. Because adding `ONLY` on a query that returns a single record will return a single object, we should be able to add `.entries()` to the end of this.

```surql
CREATE town:sukh SET name = "Sukh", population = 2955;
-- Full path syntax
object::entries(SELECT * FROM ONLY town:sukh);
-- Method syntax
(SELECT * FROM ONLY town:sukh).entries();
```

**Response**

```surql
[
  [ 'id', town:sukh ],
  [ 'name', 'Sukh' ],
  [ 'population', 2955 ]
]
```

So far so good! Now what if we add a second town, the town of The Naimo? Now that we have more than one town, how can we call the `.entries()` method on each one? With only two towns we could certainly call `.entries()` on each index, but that isn't very satisfying or a good idea in the long term.

```surql
CREATE town:sukh SET name = "Sukh", population = 2955;
CREATE town:the_naimo SET
    name = "The Naimo",
    population = 7490,
  data = {
    location: "Northwest of Toria",
    geography: "Coastal town"
  };
LET $towns = SELECT * FROM town;
RETURN [
    $towns[0].entries(),
    $towns[1].entries()
];
```

There are many ways to do this that we will learn throughout this book, but in this chapter we will look at the easiest one: destructuring syntax. SurrealQL has an interesting `@.` syntax that gives access to the current record inside of a query. This can be followed with `{}` to create a structure to return, in the same way that we learned about destructuring in Chapter 1.

Now, on its own this is identical to adding field names to a `SELECT` query, so the following two queries will return the same result.

```surql
CREATE town:sukh SET name = "Sukh", population = 2955;
CREATE town:the_naimo SET
    name = "The Naimo",
    population = 7490,
  data = {
    location: "Northwest of Toria",
    geography: "Coastal town"
  };
SELECT @.{
    name,
    population
} FROM town;
SELECT 
    name,
    population
FROM town;
```

However, since the structure used after `@` is by itself an object, that means that we can call the `.entries()` method on that! Let's give it a try with the `name` and `population` fields for each town.

```surql
CREATE town:sukh SET name = "Sukh", population = 2955;
CREATE town:the_naimo SET
    name = "The Naimo",
    population = 7490,
  data = {
    location: "Northwest of Toria",
    geography: "Coastal town"
  };
SELECT @.{
    name,
    population
}.entries() FROM town;
```

**Response**

```surql
[
  [
    [ 'name', 'Sukh' ],
    [ 'population', 2955 ]
  ],
  [
    [ 'name', 'The Naimo' ],
    [ 'population', 7490 ]
  ]
]
```

The `@` syntax was actually added in version 2.1 for another completely different purpose called recursive paths which we will look at much later in the book. However, using `@` just happens to be convenient in some other cases as well, like this one.

The next two types that we will learn have quite a few of their own dedicated functions too.

## Datetimes, string prefixes, durations, and sleeping

SurrealDB has two types for working with time: `datetime` and `duration`. SurrealDB is able to cast a string into a `datetime` as long as it matches the [RFC 3339](https://datatracker.ietf.org/doc/html/rfc3339) datetime format, which is as follows:

```surql
YYYY-MM-DDTHH:MM:SSZ
```

If the input doesn't match the RFC 3339 format, you'll see an error.

```surql
RETURN <datetime>'2025-06-06T12:00:00Z';
// Wrong format: has a _ between the year and month instead of -
RETURN <datetime>"2025_06-06T12:00:00Z";
```

**Response**

```surql
d'2025-06-06T12:00:00Z'
"Expected a datetime but cannot convert '2025_06-06T12:00:00Z' into a datetime"
```

A datetime can also take milliseconds at the end, so this input is valid too.

```surql
RETURN <datetime>'2025-06-06T12:00:00.101Z';
```

**Response**

```surql
d'2025-06-06T12:00:00.101Z'
```

As a convenience, a string with just a year, month, and day can be cast into a datetime. The time will be set to midnight.

```surql
RETURN <datetime>"2025-06-06";
```

**Response**

```surql
d'2025-06-06T00:00:00Z'
```

If you want to display a `datetime` in some other string format, you can use the `time::format()` function. Here are two examples of the function in action:

```surql
RETURN time::format(<datetime>'2025-06-06', "%Y%m");
RETURN time::format(<datetime>'2025-06-06', "Day %d of month %m of year %y");
```

**Response**

```surql
'202506'
'Day 06 of month 06 of year 24'
```

As the examples indicate, the string passed into this function can contain certain letters preceded by `%` that are used to insert the datetime info at that point. There are far too many types of formatting options you can pass in to this function to mention them all here, but the [formatters reference page](/docs/reference/query-language/language-primitives/formatters) has them all if you want to take a look.

If you have input that might be a datetime, or might also be a string with a different date format, you could use the `time::format()` function to change the format of the input if it matches a `datetime`, or just pass it on as a string otherwise. SurrealDB's `string::is_datetime()` function will allow us to see if a string is properly formatted or not.

We don't know exactly when Toria was founded or what year Aeon is living in, but the people of Aeon's time certainly have their own calendar to work from, such as "day 15 of month 3, 350 years since the founding of Toria". A `datetime` will work for that sort of date too!

```surql
RETURN string::is_datetime("0350-03-15");
-- true
```

Combining the `time::format()` and `string::is_datetime()` functions might be useful for Aeon, as the world at this point in time now has two types of records:

- Historical records: many are only accurate to the month. Aeon can take these inputs as strings and simply add a "-15" for simplicity to set them to the middle of the month, such as `<datetime>"0350-03-15"`. As proper datetimes, they will be easier for Aeon to calculate the duration between events.

- Current events: the time can be more accurately specified, maybe to the hour or even the minute.

Here's an example of a historical event that is only accurate to the month. Thanks to the `string::is_datetime()` function, no error is generated even when the date is "0003-04".

```surql
-- This event took place long before the tunnel was discovered,
-- so is only accurate down to the month
LET $date = "0003-04";
LET $info = "First ever democratic elections in Toria";
CREATE ONLY event SET
    at = (IF string::is_datetime($date) {
        <datetime>$date
    } ELSE {
        <datetime>($date + "-15")
    }),
    at_historical = time::format(at, "Month %m Day %d, %Y years since Toria's glorious founding"),
    info = $info;
```

This next event is more accurate, as Aeon can just look at the clock and see that it's 8 am and use that as the time of day.

```surql
LET $date = "0424-04-24T08:00:00Z";
LET $info = "Start of day 50 of the project to restore civilization";
CREATE ONLY event SET
    at = IF string::is_datetime($date) {
        <datetime>$date
    } ELSE {
        <datetime>$date + "-15"
    },
    at_historical = time::format(at, "Month %m Day %d, %Y glorious years since Toria's founding"),
    info = $info;
```

Aeon could then set the date the next day as a parameter, and then use it to determine how long it has been since each event has passed.

```surql
LET $today = <datetime>"0424-04-25";
SELECT $today - at AS time_passed, * FROM event;
```

**Response**

```surql
[
  {
    at: d'0424-04-24T08:00:00Z',
    at_historical: "Month 04 Day 24, 0424 glorious years since Toria's founding",
    id: event:ef1ro8e65z6omoetayfv,
    info: 'Start of day 50 of the project to restore civilization',
    time_passed: 16h
  },
  {
    at: d'0003-04-15T00:00:00Z',
    at_historical: "Month 04 Day 15, 0003 years since Toria's glorious founding",
    id: event:eazx0ovuem7ivueaz6hy,
    info: 'First ever democratic elections in Toria',
    time_passed: 421y16w1d
  }
]
```

Another way you can check for valid input is by using "string prefixes", similar to the `dec` suffix we learned in Chapter 1 except that they come before the input instead of after. These force SurrealDB to treat the input as one of following types instead of a string, depending on the prefix:

- r: a record ID

- d: a datetime

- u: a UUID

As we learned in Chapter 1, these are instructions to the parser to treat the input as a certain type, as opposed to a cast which tells the database to change a value to another value.

So with a string prefix, a query won't even work if the input is wrong! Neither SurrealDB Studio nor the CLI will even let you run the query below, and will often even know exactly which part of the input is incorrect.

```surql
RETURN d'27000024-06-06T12:00:00Z';
RETURN r'person:::::aeon';
RETURN u'01912b31-d67d-704b-b49d-WRONGINPUT';
```

**Response**

```surql
-------- Query --------
"There was a problem with the database: Parse error: Unexpected character `4`, expected datetime separator characters `-`
 --> [1:17]
  |
1 | RETURN d'27000024-06-06T12:00:00Z';
  |                 ^"
-------- Query --------
"There was a problem with the database: Parse error: Unexpected token '::' expected :
  |
1 | RETURN r'person:::::aeon';
  |                ^^
"
-------- Query --------
"There was a problem with the database: Parse error: Unexpected character `W` expected hexidecimal digit
 --> [1:34]
  |
1 | RETURN u'01912b31-d67d-704b-b49d-WRONGINPUT';
  |                                  ^"
```

The `d` and `u` prefixes will show up in the output of a query to let you know that the output is a `datetime` or a `uuid`, and not a string. Conversely, a Record ID for its part will show up without quotes so that you can tell that it is a Record ID and not a string.

```surql
RETURN [
    d'2724-06-06T12:00:00Z',
    u'019a243a-bc99-7e23-a4a5-9b632ec8264d',
    r'person:aeon'
];
```

**Response**

```surql
[
  d'2724-06-06T12:00:00Z',
  u'019a243a-bc99-7e23-a4a5-9b632ec8264d',
  person:aeon
]
```

A `duration` represents a period of time, and works together with `datetime` in a way you would expect. You can create a `duration` to add or subtract to a `datetime`, or subtract one `datetime` from another to return a `duration`, as we did in the query above.

Durations use `y` for years, `w` for weeks, `d` for days, `h` for hours, `m` for minutes, `s` for seconds, `ms` for milliseconds, `us` for microseconds, and `ns` for nanoseconds. You can also use the Greek `µs` for microseconds, as µ is the Greek letter mu (similar to m). Indeed, `us` is only used because `u` is the most similar letter to `µ` - a letter that most people won't be able to type on their keyboard.

Months vary from 28 to 31 days in length, so there is no duration for month.

Constructing a duration is easy: you can just use integers followed by these suffixes.

```surql
RETURN 1y1m1s;
```

**Response**

```surql
1y1m1s
```

Let's use one of the numerous `type::is_` functions to make sure that the type returned is indeed a `duration`.

```surql
RETURN type::is_duration(1y1m1s);
1y1m1s.is_duration();
```

**Response**

```surql
true
true
```

It is!

SurrealDB is pretty lenient when it comes to input for a `duration`. Order doesn't matter, and you can even specify the same unit type as many times as you like.

```surql
RETURN 1y1m      + 1m1y;
RETURN 1ms1ms1s  + 1ms1ms1s;
```

**Response**

```surql
2y2m
2s4ms
```

Now let's try subtracting one `datetime` from another to get a `duration`.

```surql
LET $first = time::now();
LET $second = time::now();
RETURN $second - $first;
```

The output for this will be an incredibly small duration of time, like `48µs` or `14µs600ns`.

SurrealDB also has a statement called [SLEEP](/docs/reference/query-language/statements/sleep) which is incredibly easy to use: just type `SLEEP` and the `duration` to sleep for.

```surql
LET $first = time::now();
SLEEP 1s;
LET $second = time::now();
RETURN $second - $first;
```

The output for this will be at least a second: `1s1ms966µs300ns`.

Putting a query to sleep can be useful in a few limited cases. You can use it to test behaviour, or to simulate a condition. For example, you might want to simulate the [latency between regions](https://learn.microsoft.com/en-us/azure/networking/media/azure-network-latency/azure-network-latency.jpg) so that you can get an idea of what it's like to use your app for someone from a distant part of the world. Or you could use `SLEEP` to delay a response if you want to prevent users from trying to log in over and over again.

You might also need to delay the database by a little bit to ensure that a record with an ID based on the current time is always unique. The following query shows what happens if you don't tell the database to wait for a bit:

```surql
CREATE person:[time::now()];
CREATE person:[time::now()];
CREATE person:[time::now()];
```

One or more of the `CREATE` statements might fail, because these operations are so simple that the current timestamp might not yet have changed once the next `CREATE` statement starts.

```surql
[
  {
    id: person:[
      d'2025-06-24T03:50:48.253Z'
    ]
  }
]
-------- Query --------
"Database record `person:[d'2025-06-24T03:50:48.253Z']` already exists"
-------- Query --------
"Database record `person:[d'2025-06-24T03:50:48.253Z']` already exists"
```

Adding a quick `SLEEP 1ms` in between these queries is enough to ensure that the timestamps are unique.

## Type inference and default values

SurrealDB can be surprisingly flexible at times, returning a successful result when you might expect it to generate an error. This is thanks to type inference.

```surql
CREATE counter:my_counter SET value += 1;
```

Interestingly, the query is successful and returns a `counter` with its `value` set to 1.

```surql
[
  {
    id: counter:my_counter,
    value: 1
  }
]
```

The query works because the parser sees a `+=` (the "incrementing operator") followed by a number. It is able to conclude that `value` must be a number, and since `value` has not been set yet, it can be treated as a number at its default value: 0.

Similarly, this query also works.

```surql
CREATE city:toria SET nicknames += "The centre of the known world";
```

**Response**

```surql
[
  {
    id: city:toria,
    nicknames: [
      'The centre of the known world'
    ]
  }
]
```

The `+=` operator doesn't work for strings, but it does work for arrays by adding an item to the array. SurrealDB therefore concludes that `nicknames` must be an `array<string>`. And since the default value of an array is an empty array, it adds the string to the array and returns the array above with a single string inside.

## Tip: Check the documentation

SurrealDB has a lot of statements you can use, and each one can be written in a lot of different ways. That means that it won't be obvious just from looking at examples what the possibilities are for a certain statement. However, each statement does have its own doc page that contains the entire possible syntax, and this is not too difficult to read.

Some of them are incredibly easy, like SLEEP and RETURN:

```surql
SLEEP @duration;
RETURN @value;
```

Others require reading through the syntax step by step. Let's take the [syntax for CREATE](/docs/reference/query-language/statements/create) as an example. It looks like this:

```surql
CREATE [ ONLY ] @targets
  [ CONTENT @value
    | SET @field = @value ...
  ]
  [ RETURN NONE | RETURN BEFORE | RETURN AFTER | RETURN DIFF | RETURN @statement_param, ... ]
  [ TIMEOUT @duration ]
;
```

To read a statement's syntax, just go from top to bottom as you keep the following points in mind:

- Anything between [] is optional,

- Anything not between [] is mandatory,

- `|` is used to list choices,

- ... means continuation,

- @ is used to mark a parameter or a value.

So let's try that with `CREATE` from top to bottom to see how we can use it.

- You have to start with `CREATE`.

- You can then add `ONLY` if you want to return a single value instead of an array of values.

- You then have to choose a `@target` (like a `person` or a `user`).

- To add some values, use either `CONTENT` for a full object or `SET` to set one field at a time.

- You can then choose what you want to return once the statement is over. The choices are RETURN NONE, RETURN BEFORE, RETURN AFTER, RETURN DIFF, or RETURN plus one or more parameters.

- Finally, you can choose to set a timeout.

Knowing this, we can create a `town` with the longest syntax possible for the `CREATE` statement. We'll use `ONLY`, add some `CONTENT`, return the `$after` value along with a bunch of other random fields, and give it a one second timeout. Here it is!

```surql
CREATE ONLY town
    CONTENT {
        name: "Toria",
        population: 3500
    }
    RETURN
        "Nice" AS the_weather_today,
        10,
        15 AS another_number,
        $after
    TIMEOUT 1s;
```

**Response**

```surql
{
  10: 10,
  after: {
    id: town:x3ggms7myoxg426pzax2,
    name: 'Toria',
    population: 3500
  },
  another_number: 15,
  the_weather_today: 'Nice'
}
```

Nice work in this chapter! There was a lot to learn. Let's hope that Aeon is not finding all the new ideas and concepts too overwhelming.

Practice time

```surql
LET $data = [
    { name: "Toria",     population: 20685  },
    { name: "Sukh",      population: 2955   },
    { name: "Abeston",   population: 1000  }
];
```

Answer

You can use the `type::record()` function to construct their record IDs. Don't forget to use `SET` to add its name and population too!

```surql
FOR $town_data IN $data {
    CREATE type::record("town", $town_data.name)
        SET
            name = $town_data.name,
            population = $town_data.population;
};
```

### 2. How would you delete all of these towns with a population greater than 2000? And how would you return the deleted records while doing so?

Answer

A `DELETE` statement with a `WHERE` clause will do the trick. Since the `$after` value of a deleted record is an empty value, you'll want to add `RETURN BEFORE` (or `RETURN $before`) to return the records as they were before the deletion happened.

```surql
DELETE town WHERE population > 2000 RETURN BEFORE;
DELETE town WHERE population > 2000 RETURN $before;
```

### 3. How would you select each of these towns with a single field called `description` that automatically has an output like "A town called Toria" or "A town called Abeston"?

Answer

You can use the `record::tb()` function to get the table name, and then concatenate some strings together to form the `description`. Then finish up with `AS description` at the end to make sure that it has a nice readable field name instead of the ugly `"'A ' + record::tb(id) + ' called ' + name"`.

```surql
SELECT
    "A " + record::tb(id) + " called " + name AS description
    FROM town;
```

### 4. This query doesn't parse correctly. Can you fix it by checking the documentation?

```surql
UPDATE town SET location = "Centre of the world"
  WHERE name = "Toria"
  TIMEOUT 1s
  RETURN NONE;
```

Answer

The reason why the query doesn't parse correctly is because `RETURN` needs to come before `TIMEOUT`, as the syntax shows:

```surql
UPDATE [ ONLY ] @targets
  [ CONTENT @value
    | MERGE @value
    | PATCH @value
    | [ SET @field = @value, ... | UNSET @field, ... ]
  ]
  [ WHERE @condition ]
  [ RETURN NONE | RETURN BEFORE | RETURN AFTER | RETURN DIFF | RETURN @statement_param, ... ]
  [ TIMEOUT @duration ]
;
```

Moving `TIMEOUT` to the end will fix it.

### 5. How can you check to see how long multiple queries take?

Answer

You can use the `time::now()` function to first create a parameter, then run your queries, and finally return the current time again minus the original parameter you created at the beginning.

If you are just experimenting with creating a lot of records (like in the query below), be sure to use `RETURN NONE` so that you don't have to deal with all the output of the created records.

```surql
LET $now = time::now();
CREATE |town:1000|   RETURN NONE;
CREATE |person:1000| RETURN NONE;
RETURN time::now() - $now;
```
