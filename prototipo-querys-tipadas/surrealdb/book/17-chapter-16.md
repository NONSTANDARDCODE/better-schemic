# Chapter 16: Keeping knowledge free

**Time elapsed: 35y**

> *Your plan to recreate the Minitel is going well, especially in your part of the world where people are used to working with technology. The great powers of Europe wanted the same access, and you were willing to grant it. You put an offer together that provides a number of Minitels for government usage, just as they asked.*

> *However, there were conditions - tough ones. One was that they must allow Landevin to put together a team that can set up Minitels wherever they like. And everyone, even the poorest citizen, must be able to access it for free. Any government that interferes with the team will lose all access to the network.*

> *The last condition was the hardest: allowing Landevin's team to visit anywhere unannounced, including courts and jails. How they hated that one! And they all refused at first, except San Marino. The other countries were shocked, calling it "unworthy of an independent country". Then a few months went by and San Marino began to gain a huge technological advantage over them. They all jumped aboard after that.*

> *You know that they will eventually figure out the technology for themselves, but for the moment there is no danger of this happening. The knowledge is all inside your database, and all they can do is display the results on the screen which they write down on paper for their own use later. You smile as you remember doing the exact same thing so many years ago when the printer first ran out of ink...*

A full 35 years have passed since Aeon began the project to restore civilisation, and it seems to be getting closer to succeeding. There isn't much time left! In this small amount of time remaining to us, let's focus on advanced queries and any other concepts that we haven't encountered yet over the next two chapters to ensure that we are as fluent in SurrealQL as possible.

## `DEFINE API`

Aeon seems to be very interested in keeping access to knowledge as free as possible.

Now, one of the problems that can happen when you make a service free for all to use is that it gets used a lot - so much that the service itself slows down. It would be nice to set some limits on the usage of the database so that you can make sure that free users don't take up all of the bandwidth. This is called rate limiting.

In SurrealDB, this can be achieved by using a statement called [`DEFINE API`](/docs/reference/query-language/statements/define/api). This statement lets you create your own endpoints for users to access. Here is an example of a simple endpoint that returns all of the `article` records in the database.

```surql
-- Some sample articles...
INSERT INTO article [
  { title: "agriculture", text: "Agriculture is the practice of cultivating the soil, planting, raising, and harvesting both food and non-food crops..." },
  { title: "Plato", text: "Plato (Greek: Πλάτων, Plátōn; born c. 428–423 BC, died 348/347 BC) was an ancient Greek philosopher of Classical Athens who is..."},
  { title: "Kago", text: "Kago is a city once known as Chicago. It was the most populous city in the U.S. state of Illinois and in the Midwestern United States..."}
];
DEFINE API "/articles" FOR get THEN {
    RETURN {
        status: 200,
        body: {
            content: SELECT * FROM article
        },
        headers: {}
    }
};
```

The things to note here are:

- "/articles" is the name of the endpoint. This will show up at the end of the route `/api/namespace/database`. For example, if you started an instance with `surreal start` and used the namespace `aeons_namespace` and database `aeons_database`, this API endpoint would be accessible at `http://localhost:8000/api/aeons_namespace/aeons_database/articles`.

- `FOR get` means a GET request, the simplest kind. With a GET request, the user just requests that the endpoint give it a response and doesn't provide any additional data.

- The response contains `headers`, a `status`, and a `body`.

We can test this endpoint out in a number of ways. One is by using a function called `api::invoke`.

```surql
api::invoke("/articles");
```

Another way is by using something like curl or Postman or some other API testing tool. Here is how you would

```surql
curl -X GET http://localhost:8000/api/aeons_namespace/aeons_database/articles -H "Accept: application/json"
```

You'll see an output like this that shows that the endpoint is working as expected.

```surql
{
	body: {
		content: [
			{
				id: article:90ptjdmd4flkjrwhp0qn,
				text: 'Kago is a city once known as Chicago. It was the most populous city in the U.S. state of Illinois and in the Midwestern United States...',
				title: 'Kago'
			},
			{
				id: article:jbrq3qtihati6a3l84tv,
				text: 'Plato (Greek: Πλάτων, Plátōn; born c. 428–423 BC, died 348/347 BC) was an ancient Greek philosopher of Classical Athens who is...',
				title: 'Plato'
			},
			{
				id: article:wtfgdv5fgte2ey32wf13,
				text: 'Agriculture is the practice of cultivating the soil, planting, raising, and harvesting both food and non-food crops...',
				title: 'agriculture'
			}
		]
	},
	headers: {},
	raw: NONE,
	status: 200
}
```

Pretty good so far! But a `SELECT * FROM article` query could take a long time if there are a lot of `article` records. How can this be improved?

The first thing we can do is change the `get` to a `post`, so that the user can post some info inside an object. This information is available inside a set parameter called `$request`. With that, we can add a `WHERE $request.body.keyword IN text`, in which `keyword` is a field that holds a keyword to search for such as "Greek", or "Kago", or "harvesting". That will cut down on the number of articles returned.

```surql
DEFINE API "/articles" FOR post
  THEN {
      RETURN {
          status: 200,
          body: {
              content: SELECT * FROM article WHERE $request.body.keyword IN text
          },
          headers: {}
      }
};
```

With that, a user can now use the endpoint along with the object `{"keyword": "Greek"}` that will lead to a `SELECT * FROM article WHERE "Greek" IN text` query.

```surql
curl -X POST http://localhost:8000/api/aeons_namespace/aeons_database/articles \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"keyword": "Greek"}'
```

The output will look like this. Pretty good so far!

```surql
{
	content: [
		{
			id: 'article:4bq21eawqcr8v3gahfml',
			text: 'Plato (Greek: Πλάτων, Plátōn; born c. 428–423 BC, died 348/347 BC) was an ancient Greek philosopher of Classical Athens who is...',
			title: 'Plato'
		}
	],
	request: {
		body: {
			keyword: 'Greek'
		},
		headers: {
			accept: 'application/json',
			"content-length": '20',
			"content-type": 'application/json',
			host: 'localhost:8000',
			"user-agent": 'curl/8.7.1',
			"x-request-id": 'aff27f82-37a5-4417-9417-32999ad72528'
		},
		method: 'post',
		params: {},
		query: {}
	}
}
```

Our API endpoint now returns a generally smaller number of articles, but there's nothing in there to specifically limit the amount of resource time that a user can have. Let's now change the endpoint so that instead of returning the results of a single keyword, it takes an array of keywords and does a `SELECT` for each one of them.

```surql
content: $request.body.keywords.map(|$k| SELECT * FROM article WHERE $k IN text)
```

Since we are making this endpoint for free users, we don't want them to pass in hundreds of keywords per request. Ideally, they should only add a few. But instead of trying to put some logic together based on user type, system load and so on, we can just give each request a maximum timeout.

This can be done by adding a clause called `MIDDLEWARE`. After the `MIDDLEWARE` clause you can insert [api functions](/docs/reference/query-language/functions/database-functions/api) to specify certain behaviour like a maximum body size, timeout, what headers should be added, and so on. We will use just one of them: the 'api::timeout()' function.

The example below will now include 10,000 other articles with random strings to fill up the database a bit and have the operation take longer.

```surql
INSERT INTO article [
  { title: "agriculture", text: "Agriculture is the practice of cultivating the soil, planting, raising, and harvesting both food and non-food crops..." },
  { title: "Plato", text: "Plato (Greek: Πλάτων, Plátōn; born c. 428–423 BC, died 348/347 BC) was an ancient Greek philosopher of Classical Athens who is..."},
  { title: "Kago", text: "Kago is a city once known as Chicago. It was the most populous city in the U.S. state of Illinois and in the Midwestern United States..."}
];
FOR $_ IN 0..10000 {
    CREATE article SET text = rand::string(1000);
};
DEFINE API "/articles" FOR post
       MIDDLEWARE
            api::timeout(100ms)
THEN {
    RETURN {
        status: 200,
        body: {
            request: $request,
            content: $request.body.keywords.map(|$k| SELECT * FROM article WHERE $k IN text)
        },
        headers: {}
    }
};
```

With a 100m timeout, a request like this will work just fine.

```surql
curl -X POST http://localhost:8000/api/ns/db/articles \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"keywords": ["Plato", "Agriculture"]}'
```

But this next unserious query with far too many keywords will not work. Thanks to the middleware, the server simply gives up after 100 milliseconds and tells the user to go check the documentation.

```surql
curl -X POST http://localhost:8000/api/ns/db/articles \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{'keywords': ["You", "were", "excited", "to", "hear", "the", "news", "this", "morning", "about", "a", "large", "number", "of", "books", "discovered", "in", "the", "mountains."]}'
{"code":400,"details":"Request problems detected","description":"There is a problem with your request. Refer to the documentation for further information.","information":"The query was not executed because it exceeded the timeout"}%
```

Wonderful! Now how do we force users to use this endpoint instead of signing in and doing their own queries? This is done by using a flag when starting the server called `--deny-arbitrary-query`. This flag is followed by `guest`, `record`, or `system`, depending on what level you want to set it at. The most common usage is probably `--deny-arbitrary-query record`, which lets you force record users to use the API endpoints while allowing system users to do whatever they need to do. Here is a simple example of the `surreal start` command that uses this flag.

```surql
surreal start --user root --pass password --deny-arbitrary-query record
```

Now let's turn our attention back to the query language and see what other tips and tricks we can cover during this chapter.

## Multiple table types in relation queries and using the ? wildcard operator

We learned about bidirectional querying with the `<->` operator in Chapter 8, which let us create marriages and friendships that could only be defined once thanks to a unique index on a key which was created by the sorted Record IDs found at the `in` and `out` fields.

Here is a similar example to the one we saw in that chapter.

```surql
DEFINE FIELD key
  ON TABLE friends_with
  VALUE <string>[in, out].sort();
DEFINE INDEX only_unique
  ON TABLE friends_with
  FIELDS key
  UNIQUE;
```

Thanks to this key, we can only RELATE with `friends_with` once, and the second `RELATE` statement will fail.

```surql
CREATE cat:one SET name = "Mr. Meow";
CREATE cat:two SET name = "Mrs. Meow";
RELATE cat:one->friends_with->cat:two;
RELATE cat:two->friends_with->cat:one;
```

**Response**

```surql
-------- Query --------
[
  {
    id: cat:one,
    name: 'Mr. Meow'
  }
]
-------- Query --------
[
  {
    id: cat:two,
    name: 'Mrs. Meow'
  }
]
-------- Query --------
[
  {
    id: friends_with:8ftj8k72f2rdbwwe56f2,
    in: cat:one,
    key: '[cat:one, cat:two]',
    out: cat:two
  }
]
-------- Query --------
"Database index `only_unique` already contains '[cat:one, cat:two]', with record `friends_with:8ftj8k72f2rdbwwe56f2`"
```

After that, a bit of query magic with the `array::complement()` function lets us find every friend that a `cat` has, except for itself.

```surql
DEFINE FIELD key
  ON TABLE friends_with
  VALUE <string>[in, out].sort();
DEFINE INDEX only_unique
  ON TABLE friends_with
  FIELDS key
  UNIQUE;
CREATE cat:one SET name = "Mr. Meow";
CREATE cat:two SET name = "Mrs. Meow";
RELATE cat:one->friends_with->cat:two;
SELECT
  name,
  array::complement(<->friends_with<->cat.*, [$this]) AS friends
FROM cat;
```

**Response**

```surql
[
  {
    friends: [
      {
        id: cat:two,
        name: 'Mrs. Meow'
      }
    ],
    name: 'Mr. Meow'
  },
  {
    friends: [
      {
        id: cat:one,
        name: 'Mr. Meow'
      }
    ],
    name: 'Mrs. Meow'
  }
]
```

Now what happens if a dog would like to be friends too? We can easily set up a the relation:

```surql
CREATE dog:one SET name = "Mr. Bark";
RELATE dog:one->friends_with->cat:one;
RELATE dog:one->friends_with->cat:two;
```

But the `<->friends_with<->cat` part of the `SELECT` query above is only looking for cats at the end of the `friends_with` graph table, instead of both cats and dogs. We can fix this by changing `<->cat` to `<->(cat, dog)`, and by selecting `FROM cat, dog` instead of just `FROM cat`. This will now look for all possible cat or dog friends of each cat and dog in the database.

```surql
DEFINE FIELD key
  ON TABLE friends_with
  VALUE <string>[in, out].sort();
DEFINE INDEX only_unique
  ON TABLE friends_with
  FIELDS key
  UNIQUE;
CREATE cat:one SET name = "Mr. Meow";
CREATE cat:two SET name = "Mrs. Meow";
CREATE dog:one SET name = "Mr. Bark";
RELATE cat:one->friends_with->cat:two;
RELATE dog:one->friends_with->cat:one;
RELATE dog:one->friends_with->cat:two;
SELECT
  name,
  array::complement(<->friends_with<->(cat, dog).*, [$this]) AS friends
FROM cat, dog;
```

**Response**

```surql
[
  {
    friends: [
      {
        id: dog:one,
        name: 'Mr. Bark'
      },
      {
        id: cat:two,
        name: 'Mrs. Meow'
      }
    ],
    name: 'Mr. Meow'
  },
  {
    friends: [
      {
        id: cat:one,
        name: 'Mr. Meow'
      },
      {
        id: dog:one,
        name: 'Mr. Bark'
      }
    ],
    name: 'Mrs. Meow'
  },
  {
    friends: [
      {
        id: cat:one,
        name: 'Mr. Meow'
      },
      {
        id: cat:two,
        name: 'Mrs. Meow'
      }
    ],
    name: 'Mr. Bark'
  }
]
```

If you would like to match on *any* record type, you can use the `?` wild card operator instead. Using this, we could see each of a cat's friends, be they cats, dogs, humans, or anything else.

```surql
SELECT
  name,
  array::complement(<->friends_with<->(?).*, [$this]) AS friends FROM cat;
```

Here is another simpler example of the `?` operator in action. Landevin, who is in Europe, has recently seen an interesting comet and has also visited a city known as Lutetia. At the same time, a villager from Lutetia noticed him and wondered just what this suspicious outsider was up to.

We can represent these pieces of data and their relations with some pretty simple queries.

```surql
CREATE comet:unknown_comet;
CREATE city:lutetia            SET name = "Lutetia";
CREATE person:landevin         SET name = "Landevin";
CREATE person:lutetia_villager SET name = "Some villager";
RELATE person:landevin->saw->comet:unknown_comet;
RELATE person:landevin->visited->city:lutetia;
RELATE person:lutetia_villager->saw->person:landevin;
```

Landevin at this point has three relations in total: he visited somewhere, he saw something, and he was seen. If we want to see them all, we could use the `?` operator to ask SurrealDB to return whatever it finds at the end of each graph table related to this `person:landevin` record.

```surql
SELECT
  *,
  ->? AS did,
  <-? AS done_to,
  <->? AS everything
FROM person:landevin;
```

**Response**

```surql
[
  {
    did: [
      saw:prkolwy3aaak7vp5yrub,
      visited:vdt5e5jz1zk0gpeeoz5r
    ],
    done_to: [
      saw:67xhm5pvmdc4h1sswa8p
    ],
    everything: [
      saw:67xhm5pvmdc4h1sswa8p,
      saw:prkolwy3aaak7vp5yrub,
      visited:vdt5e5jz1zk0gpeeoz5r
    ],
    id: person:landevin,
    name: 'Landevin'
  }
]
```

And for something a little more readable, we can also add `.*` to display all the fields of these related records. This next query will show all the fields of the records Landevin *did something to*, followed by all the fields of the records that *did something to him*.

```surql
SELECT
  *,
  ->?.out.* AS did_something_to,
  <-?.in.* AS done_by
FROM person:landevin;
```

**Response**

```surql
[
  {
    did_something_to: [
      {
        id: comet:unknown_comet
      },
      {
        id: city:lutetia,
        name: 'Lutetia'
      }
    ],
    done_by: [
      {
        id: person:lutetia_villager,
        name: 'Some villager'
      }
    ],
    name: 'Landevin'
  }
]
```

A `WHERE` clause can also be added to a relation query. If we only wanted to see records that had a `name`, we could add a `WHERE` clause to filter out the records that don't have this information (in this case, just the mysterious comet). That gives us the query below which shows everything that has a relation to Landevin, as long as it has a name.

```surql
SELECT
  *,
    ->(? WHERE $this.out.name IS NOT NONE).out.* AS did_something_to,
    <-(? WHERE $this.in.name IS NOT NONE).in.*  AS done_to
FROM person:landevin;
```

```surql
[
  {
    did_something_to: [
      {
        id: city:lutetia,
        name: 'Lutetia'
      }
    ],
    done_to: [
      {
        id: person:lutetia_villager,
        name: 'Some villager'
      }
    ],
    id: person:landevin,
    name: 'Landevin'
  }
]
```

## The random stuff

To finish up this chapter, we will quickly go over some random bits and pieces that are good to know and quick to pick up at this point now that we have become more advanced users of SurrealDB.

### Recursive functions

One convenient aspect to defining a function is that it can call itself! Let's see what happens if we create a function that simply calls itself over and over again.

```surql
DEFINE FUNCTION fn::recurse() {
    fn::recurse();
};
fn::recurse();
```

Instead of freezing up the database, SurrealDB recognises that this would lead to too much "computation depth" and simply gives up. As the error message notes, infinite recursion can happen not only inside a function, but also due to subqueries and computed values.

```surql
'Reached excessive computation depth due to functions, subqueries, or computed values'
```

We can create a different function that only calls itself if a random bool is true, which will keep it from being called infinitely. Instead, you should see anywhere from 1 to some other small number of `person` records created.

```surql
DEFINE FUNCTION fn::create_recursive() {
    CREATE person;
    IF rand::bool() {
        fn::create_recursive();
    }
};
fn::create_recursive();
RETURN count(SELECT id FROM person);
```

For something more useful, here is a demonstration of the [Fibonacci sequence](https://en.wikipedia.org/w/index.php?title=Fibonacci_sequence&oldid=1233560077) as a SurrealQL function.

```surql
DEFINE FUNCTION fn::fibonacci($num: int) -> int {
    RETURN
             IF $num = 0 { 0 }
        ELSE IF $num = 1 { 1 }
        ELSE { fn::fibonacci($num - 1) + fn::fibonacci($num - 2) }
};
// Returns 377
RETURN fn::fibonacci(14);
```

### The TEMPFILES and TIMEOUT keywords

These keywords were mentioned once: way, way back at the very beginning of the intro of this book. Time to give them some attention!

TEMPFILES is a recent addition to SurrealDB's syntax, and is used for when you need to make queries that are so large that all the memory required ends up giving your computer a hard time. While memory is by default the most performant option, that is of no help when your computer has completely run out of spare memory and needs to start swapping back and forth with whatever spare resources it has.

In this case, you can add the TEMPFILES keyword to the end of a SELECT statement to instruct the computer to process the statement inside temporary files, rather than memory. While much slower than memory in most cases, this may result in a significant speedup for massive queries that would otherwise be a burden on your computer.

```surql
SELECT * FROM person TEMPFILES;
```

Similarly, you can also add `TIMEOUT` followed by a duration if you want SurrealDB to quit early if a query is taking too long. Note that the actual execution time will be somewhat longer than the timeout, which becomes more noticeable for queries that process massive amounts of data. The output from a query that creates 100000 records and another much larger one that creates half a million records shows the difference:

```surql
ns/db> CREATE |person:100000| RETURN NONE;
-- Query 1 (execution time: 2.3801824s)
[]
ns/db> CREATE |person:500000| RETURN NONE;
-- Query 1 (execution time: 13.3432103s)
[]
ns/db> CREATE |person:100000| RETURN NONE TIMEOUT 1s;
-- Query 1 (execution time: 1.0290052s)
'The query was not executed because it exceeded the timeout'
ns/db> CREATE |person:500000| RETURN NONE TIMEOUT 1s;
-- Query 1 (execution time: 1.1637722s)
'The query was not executed because it exceeded the timeout'
```

### The EXPLAIN keyword

You can gain some insight into what method SurrealDB is using in your queries by adding the EXPLAIN keyword. Take the following two queries on some simple `person` records, one of which uses an index, and one that doesn't.

```surql
DEFINE INDEX unique_name ON TABLE person FIELDS name UNIQUE;
CREATE person SET name = "Fernçois", address = "10 Boulevard de Lutetia" RETURN NONE;
SELECT * FROM person WHERE name = "Fernçois" EXPLAIN;
SELECT * FROM person WHERE address CONTAINS "Lutetia" EXPLAIN;
```

**Response**

```surql
-------- Query --------
[
  {
    detail: {
      plan: {
        index: 'unique_name',
        operator: '=',
        value: 'Fernçois'
      },
      table: 'person'
    },
    operation: 'Iterate Index'
  },
  {
    detail: {
      type: 'Memory'
    },
    operation: 'Collector'
  }
]
-------- Query --------
[
  {
    detail: {
      table: 'person'
    },
    operation: 'Iterate Table'
  },
  {
    detail: {
      type: 'Memory'
    },
    operation: 'Collector'
  }
]
```

Note that 'Iterate Table' (also known as a table scan) shows up once an index has not been found, which means a scan over every record in the database. As the fallback option, this tends to be less performant than other ways to query your data.

We can demonstrate this by first creating a bunch of person objects with an id going from 1 to 100000. We will then compare two queries, one of which uses the `WHERE` clause (which will perform a table scan), while the other uses the `..` range syntax which will be much faster.

To do a quick comparison, we will create a variable to hold the time before the operation, and then will subtract it from the time after the operation to get the duration. And to ensure that the `SELECT` statement doesn't clutter up the screen, we'll assign it to a variable called `$nothing` that we will never read.

```surql
CREATE |person:1..100000| RETURN NONE;
LET $now = time::now();
LET $nothing = SELECT * FROM person WHERE id >= person:99900;
RETURN "Time elapsed: " + <string>(time::now() - $now);
LET $now = time::now();
LET $nothing = SELECT * FROM person:99900..;
RETURN "Time elapsed: " + <string>(time::now() - $now);
DELETE person;
```

Adding the `EXPLAIN` keyword to the end of these two queries gives the details.

```surql
-------- Query --------
[
  {
    detail: {
      table: 'person'
    },
    operation: 'Iterate Table'
  },
  {
    detail: {
      type: 'Memory'
    },
    operation: 'Collector'
  }
]
-------- Query --------
[
  {
    detail: {
      range: [
        NONE,
        NULL
      ],
      table: 'person'
    },
    operation: 'Iterate Range'
  },
  {
    detail: {
      type: 'Memory'
    },
    operation: 'Collector'
  }
]
```

### Object functions

The freeform nature of objects makes them both flexible and also somewhat unpredictable and tough to work with at times. SurrealDB has a number of functions that work on objects that can help make them easier to work with.

Three of them turn an object into an array (or array of arrays), made out of:

- its keys, using `object::keys()`

- its values, using `object::values()`

- both keys and values, using `object::entries()`

Let's give two of these functions a try with some of the possible records for the Minitels in Europe.

```surql
INSERT INTO terminal [
  {
    id: 1,
    location: (41.8924, 12.9271),
    location_notes: 'On the corner of Piazza San Marino',
    metadata: {
      employee_notes: 'San Marino was known in the 21st century as Italy, though the city name Rome remains the same. Locals have been cooperative so far.',
      terminal_name: 'Central Rome, San Marino'
    },
    password: crypto::argon2::generate('BluebirdsFlyAtMidnight')
  },
  {
    id: 2,
    metadata: {
      terminal_name: 'Brescia, San Marino'
    },
    password: crypto::argon2::generate('TatersPotatoesBoilemMashem')
  },
  {
    id: 3,
    metadata: {
      employee_notes: 'Quite a nice place to set up a terminal. Best, -- Sammael'
    },
    password: crypto::argon2::generate('SaangrealPlease')
  }
];
SELECT $object.keys() AS keys,
  $object.values() AS values
FROM terminal;
```

**Response**

```surql
[
  {
    keys: [
      'id',
      'location',
      'location_notes',
      'metadata',
      'password'
    ],
    values: [
      terminal:1,
      (41.8924, 12.9271),
      'On the corner of Piazza San Marino',
      {
        employee_notes: 'San Marino was known in the 21st century as Italy, though the city name Rome remains the same. Locals have been cooperative so far.',
        terminal_name: 'Central Rome, San Marino'
      },
      '$argon2id$v=19$m=19456,t=2,p=1$IgkmvUIF51Nd0n6Xn0bb+g$4guoUlwt6zqpLG9D5we2Q/2UEHQ8bm1rqXmR2MHqo+s'
    ]
  },
  {
    keys: [
      'id',
      'metadata',
      'password'
    ],
    values: [
      terminal:2,
      {
        terminal_name: 'Brescia, San Marino'
      },
      '$argon2id$v=19$m=19456,t=2,p=1$mALZuMrL55DICIn1gTRS5w$48YBNsv+riqNjL1mQIRHC2qJ1XYG6eniwJt3AuVUjAc'
    ]
  },
  {
    keys: [
      'id',
      'metadata',
      'password'
    ],
    values: [
      terminal:3,
      {
        employee_notes: 'Quite a nice place to set up a terminal. Best, -- Sammael'
      },
      '$argon2id$v=19$m=19456,t=2,p=1$Hnsm0kFXaG+ovwTtx0CZMA$0co//dI1ZYL4gBEqT3zbsUp6LBmbjMJET/LNflHmhJ0'
    ]
  }
]
```

SurrealDB has two more object functions: `object::len()` which returns the number of key-value pairs, and `object::from_entries()` which lets you build an object from an array of keys and values.

```surql
RETURN object::from_entries([
   [ "id", 1 ],
   [ "location", (41.8924, 12.9271) ],
   [ "location_notes", 'On the corner of Piazza San Marino' ]
]);
```

**Response**

```surql
{
  id: 1,
  location: (41.8924, 12.9271),
  location_notes: 'On the corner of Piazza San Marino'
}
```

The next chapter will be sort of a continuation of this one, but dipping into even deeper and darker parts of SurrealDB - and even some of its source code!

Practice time

### 1. You have a lot of data imported from another database with varied capitalization in the field names. What can you do?

Take the following data below as an example, which has fields called `name`, `NAME`, and `Name`.

```surql
INSERT INTO planet [
  {
      name: "Mercury"
  },
  {
      Name: "Venus"
  },
  {
      NAME: "Mars"
  },
  {
      name: "Jupiter"
  }
];
```

Answer

A lot will depend on what other fields are in the data and just how much of a mess it is. But one of SurrealDB's `object` functions should be able to help in any case. Here is an example of the `.keys()` function being used to check the spelling of the `name` field which then allows different records to be created. After this the original planet data could be deleted and replaced with this one.

```surql
FOR $planet IN SELECT * FROM planet {
    LET $new_planet = {
        id: $planet.id,
        name: IF "name" IN $planet.keys() { $planet.name }
              ELSE IF "NAME" IN $planet.keys() { $planet.NAME }
              ELSE { $planet.Name }
    };
    CREATE new_planet CONTENT $new_planet;
};
SELECT * FROM new_planet;
```

**Response**

```surql
[
  {
    id: new_planet:2x0fcr87h5y6ferce9y2,
    name: 'Mars'
  },
  {
    id: new_planet:31ov6otoni6igvgcnomz,
    name: 'Venus'
  },
  {
    id: new_planet:mil4wx8f8a5bgx03fpvd,
    name: 'Mercury'
  },
  {
    id: new_planet:wc0atjga399hd5xd5aw9,
    name: 'Jupiter'
  }
]
```

### 2. Can you write a recursive function that pulls off a random item from an array inside a record and then calls itself again and again until the array only has one item left?

To get you started, here is how a query using this function would work.

```surql
CREATE stuff_with_array:one SET data = <array>1..20 RETURN NONE;
fn::pull_off(stuff_with_array:one);
SELECT * FROM stuff_with_array;
```

Answer

One way to randomize the removal of the items is to use `.remove(0)` to remove an item from the front if the `rand::bool()` function returns `true`, and `.remove(-1)` to remove an item from the end if the `rand::bool()` function returns `false`.

```surql
DEFINE FUNCTION OVERWRITE fn::pull_off($input: record<stuff_with_array>) {
    IF $input.data.len() = 1 {
        RETURN "Done!";
    } ELSE IF rand::bool() {
        UPDATE $input SET data = data.remove(0);
        fn::pull_off($input);
    } ELSE {
        UPDATE $input SET data = data.remove(-1);
        fn::pull_off($input);
    }
};
```

### 3. The queries below create a `blog_article` that is related to a `comment` and a `review`...

How would you show all the data for the `comment` and `review` in a single query?

```surql
CREATE blog_article:comet SET content = "Did you know that comets spend most of their time...";
CREATE comment:one SET content = "I had no idea!";
RELATE comment:one->on->blog_article:comet;
CREATE review:one SET content = "Last week I found this interesting article on comets which...";
RELATE review:one->on->blog_article:comet;
```

Answer

To get all the comments, we can use the following query.

```surql
SELECT <-on<-comment.* FROM blog_article:comet;
```

However, we also want to include `review` records, which are linked by a table called `about`. To do that, we can put all these possible names in parentheses.

```surql
SELECT <-(on, about)<-(review, comment).* FROM blog_article:comet;
```

**Response**

```surql
[
  {
    "<-(on, about)": {
      "<-(comment, review)": [
        {
          content: 'I had no idea!',
          id: comment:one
        },
        {
          content: 'Last week I found this interesting article on comets which...',
          id: review:one
        }
      ]
    }
  }
]
```
