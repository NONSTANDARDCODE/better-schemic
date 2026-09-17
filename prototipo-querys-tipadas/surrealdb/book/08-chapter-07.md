# Chapter 7: A rude surprise

**Time elapsed: 2w2d**

> *What a day! It wasn't until sundown that Landevin and his group finally left for the town. They had come to deliver the town council's concerns about your project. They think there was "a reason the ancients destroyed their knowledge" and that you were repeating their mistakes by moving so quickly. They were also disturbed that databases could delete knowledge so quickly.*

> *Well, that part disturbed you too, to be honest...*

> *You were eventually able to convince them of the benefits of the project by giving them a small tour. Their jaws dropped as they saw just how much knowledge there was to benefit from and how much good it could do.*

> *You frown. Just how did they find out about deleting data anyway? You decide to have a serious talk with your team members tomorrow about confidentiality. You should also do something about security. You were able to persuade the reasonable Landevin about your project, but what if it had been someone else, like a group with torches and pitchforks? Closing the security door is always an option, but you want to keep it a secret unless you really need it one day.*

> *A certain wealthy lady has been visiting you lately for information from the new database, which she already finds quite useful. Tomorrow you will ask her to lend you a dozen of her armed men to make sure that you aren't surprised again.*

## More advanced relational queries

As Aeon finally calms down and returns to the German folk tale, we can follow along and see how the relations in the data are starting to get more complex. [Here is the current dataset](https://datasets.surrealdb.com/learn/book/book-part-6-dataset.surql) as of the end of last chapter in case you want to follow along manually instead of via the embedded SurrealDB Studio examples.

In addition to our `parent_of` graph table, we are going to need to use `RELATE` to create another sort of family relation.

What sort of relation will that be? Let's continue the story to find out. As you read it, try to imagine how you would create them in a database.

> One morning, the poor nobleman went into the forest to hunt for his dinner. He had no luck, and eventually fell asleep. He heard a sound and woke up to see a ferocious bear heading straight towards him - a bear that could talk!

> The nobleman begged for his life. "Oh please, Sir Bear, spare me and let me live!"

> The bear agreed, but only if he would give his eldest daughter to him to marry the next week. The nobleman agreed and ran back to his castle.

> The nobleman locked all the gates to the castle, but to no avail: the gates magically opened when his daughter's new husband arrived. To his surprise, the bear was now a handsome prince who paid the nobleman a huge sum for the marriage and took his daughter away.

> Unsurprisingly, the nobleman wasted all the money and became poor again.

> Over the next few months, two similar events happened to the nobleman again. First he was attacked by a huge eagle, and next by a massive fish. In both cases he agreed to allow them to marry his daughters, and they turned out to be handsome princes who took them away.

> The nobleman wasted his money again, his daughters were gone, and now he and his wife were alone.

## INSERT

It seems that the nobleman now has three sons-in-law: knights that are under a curse through which they sometimes transform into terrible creatures. That gives us some new records to create, along with a new graph table to represent their relations. These three knights each have their own castles too, much nicer than the nobleman's empty one.

We could use `CREATE` to make these `building` records, but for multiple records there is an easier way. It's called `INSERT`, and is followed by `INTO` and the table name. We have a number of options at this point, one of which is to insert an object or an array of objects. We can use this method to insert three castles at once.

```surql
INSERT INTO building [
    { id: "bear_castle",  name: "Bear castle",  kind: "castle" },
    { id: "eagle_castle", name: "Eagle castle", kind: "castle" },
    { id: "fish_castle",  name: "Fish castle",  kind: "castle" },
];
```

Note that SurrealDB can tell from the `id` field that we are specifying our own IDs, and doesn't generate a random `id` in this case.

**Response**

```surql
[
  {
    id: building:bear_castle,
    kind: 'castle',
    name: 'Bear castle'
  },
  {
    id: building:eagle_castle,
    kind: 'castle',
    name: 'Eagle castle'
  },
  {
    id: building:fish_castle,
    kind: 'castle',
    name: 'Fish castle'
  }
]
```

Another way to do the same thing is to insert using values instead of objects. This can be done by putting the field names into a tuple after `INTO`, then adding `VALUES`, and as many tuples as you like to populate these fields with the values inside. The query below will produce the same result:

```surql
INSERT INTO building (id, name, kind)
    VALUES
        ("bear_castle",  "Bear castle",  "castle"),
        ("eagle_castle", "Eagle castle", "castle"),
        ("fish_castle",  "Fish castle",  "castle");
```

`INSERT` lets you create multiple relations at a time too, by changing `INSERT` to `INSERT RELATION`. The query will work as long as you indicate which record is `in` and which record is `out`. Here is how we could have used `INSERT RELATION` to create two of the `parent_of` relations in the last chapter:

```surql
INSERT RELATION INTO parent_of (in, out, between) VALUES
  (person:the_nobleman, person:adelaide, "father-daughter"),
  (person:the_nobleman, person:bertha, "father-daughter");
```

Besides happening inside a single query, `INSERT RELATION` is particularly nice when you need dynamic input that a `RELATE` statement isn't clever enough to parse.

```surql
LET $the_nobleman = SELECT * FROM ONLY person:the_nobleman LIMIT 1;
INSERT RELATION INTO parent_of (in, out, at, between) VALUES
  (
    $the_nobleman,
    $the_nobleman.daughters[0],
    time::now(),
    $the_nobleman.role + '-' + $the_nobleman[0].role
  ),
  (
    $the_nobleman, 
    $the_nobleman.daughters[1], 
    time::now(),
    $the_nobleman.role + '-' + $the_nobleman[1].role
    );
```

### ON DUPLICATE KEY UPDATE

Both `CREATE` and `INSERT` will return an error if a record of the same ID already exists.

```surql
CREATE person:the_nobleman SET name = "Hi im the nobleman";
INSERT INTO person [
    {
        id: "the_nobleman",
        name: "Hi im the nobleman"
    }
];
```

**Response**

```surql
-------- Query --------
'Database record `person:the_nobleman` already exists'
-------- Query --------
'Database record `person:the_nobleman` already exists'
```

However, `INSERT` comes with an interesting clause called `ON DUPLICATE KEY UPDATE` that lets you decide what to do in case it finds a duplicate.

Let's imagine that we are keeping track of the population of the towns nearby. Here is the data for the town of Toria as of their year 424:

```surql
CREATE town:toria SET
    name = "Toria",
    population = 20685,
    year = <datetime>"0424-01-01";
```

Ten years later, perhaps Aeon's project is going well and the towns are growing. Our `INSERT INTO` contains some new data, but we'd like to keep the old data around too. We can do this by using `+=` to add the current data to a new field called `historical_data`. But the field names `population` and `year` are in both the existing and the new record. What can we do?

```surql
INSERT INTO town [
    { id: "toria", population: 25212, year: <datetime>"0434-01-01" }
]
ON DUPLICATE KEY UPDATE
historical_data += {
    year: year,
    population: population
},
population = population, -- What do we write here?
year = year;             -- And here?
```

Fortunately, `INSERT` gives us access to the input for the new record through the parameter `$input`. We can use this to access the fields of the record we were trying to insert, putting the data into the record that already exists in the database.

```surql
INSERT INTO town [
    { id: "toria", population: 25212, year: <datetime>"0434-01-01" }
]
ON DUPLICATE KEY UPDATE
historical_data += {
    year: year,
    population: population
},
population = $input.population,
year = $input.year;
```

**Response**

```surql
[
  {
    historical_data: [
      {
        population: 20685,
        year: d'0424-01-01T00:00:00Z'
      }
    ],
    id: town:toria,
    name: 'Toria',
    population: 25212,
    year: d'0434-01-01T00:00:00Z'
  }
]
```

Perfect!

One final note: don't forget to add the historical data first, because if you set `population` and `year` first, those will become the values of the existing record and then the *new* values would be entered into `historical_data`. Order matters here.

### IGNORE

Another thing you can do if you might encounter a duplicate record is to just ignore it. Without this keyword, even a single duplicate record ID will cause an `INSERT` operation to fail.

```surql
CREATE town:toria SET
    name = "Toria",
    population = 20685,
    year = <datetime>"0424-01-01";
INSERT INTO town (id, name, population, year) VALUES
  ("toria", "Toria", 20685, <datetime>"0424-01-01"),
  ("the_naimo", "The Naimo", 7490, <datetime>"0425-01-01");
-- Error: Database record `town:toria` already exists'
```

That's easy to fix! Just add `IGNORE` after `INSERT`, and the attempt to insert a new `town:toria` will be skipped over.

```surql
CREATE town:toria SET
    name = "Toria",
    population = 20685,
    year = <datetime>"0424-01-01";
INSERT IGNORE INTO town (id, name, population, year) VALUES
  ("toria", "Toria", 20685, <datetime>"0424-01-01"),
  ("the_naimo", "The Naimo", 7490, <datetime>"0425-01-01");
```

Now the second query only shows the successful part, the second town.

**Response**

```surql
[
	{
		id: town:the_naimo,
		name: 'The Naimo',
		population: 7490,
		year: d'0425-01-01T00:00:00Z'
	}
]
```

### Using the output of SELECT inside INSERT to duplicate data

Here's a small tip: because `INSERT` can take an array of records, and `SELECT` returns an array of records, we can combine the two!

Imagine that we have some schemafull `building` records that we'd like to experiment with but don't want to touch its schema or make any changes to the existing data. The safest thing to do would be to make a new table with the same data.

In this case, we can use `INSERT INTO` to copy the entire content into a different table name and then work with that data.

```surql
INSERT INTO building_schemaless (SELECT * FROM building);
```

This will create a table called `building_schemaless` with all the data from `building`, but no schema. This `INSERT INTO <table_name> (SELECT * FROM existing_table_name)` pattern is an easy way to experiment with your existing data without making any changes to it.

And for tables with a lot of data, you can use `LIMIT` to only bring in a certain number of records. The query below will select only the first 100:

```surql
INSERT INTO building_schemaless (SELECT * FROM building LIMIT 100);
```

With these quick tips out of the way, it's time to turn to another mental challenge: understanding relations in which who is `in` and who is `out` aren't clear.

## Bidirectional querying when a relationship is equal

We haven't created the `person` records for the three knights yet, so let's get around to that. They can all be created inside a single `INSERT` statement.

```surql
INSERT INTO person [
    { id: "bear_knight",  name: "Bear Knight",  money: 100000, properties: [building:bear_castle ] },
    { id: "eagle_knight", name: "Eagle Knight", money: 200000, properties: [building:eagle_castle] },
    { id: "fish_knight",  name: "Fish Knight",  money: 500000, properties: [building:fish_castle]  },
];
```

**Response**

```surql
[
  {
    id: person:bear_knight,
    money: 100000,
    name: 'Bear Knight',
    properties: [
      building:bear_castle
    ]
  },
  {
    id: person:eagle_knight,
    money: 200000,
    name: 'Eagle Knight',
    properties: [
      building:eagle_castle
    ]
  },
  {
    id: person:fish_knight,
    money: 500000,
    name: 'Fish Knight',
    properties: [
      building:fish_castle
    ]
  }
]
```

With these inserts complete, we can now do a query to see the names of all the properties of people that own them. To achieve this, we can add a `WHERE properties IS NOT NONE` at the end.

```surql
SELECT
    name,
    properties.name AS properties
FROM person
WHERE properties IS NOT NONE;
```

```surql
[
  {
    name: 'Bear Knight',
    properties: [
      'Bear castle'
    ]
  },
  {
    name: 'Eagle Knight',
    properties: [
      'Eagle castle'
    ]
  },
  {
    name: 'Fish Knight',
    properties: [
      'Fish castle'
    ]
  },
  {
    name: 'The Nobleman',
    properties: [
      'Old castle'
    ]
  },
  {
    name: 'The Noblewoman',
    properties: [
      'Old castle'
    ]
  }
]
```

Now it's time to marry them.

Choosing a name for this relationship is fairly easy: we can just go with `married`. However, this graph relationship is going to be a bit different than the `parent_of` relation we created in the last chapter. In the last chapter, it was clear who was `in` and who was `out` in the `parent_of` graph table. For `parent_of`, `in` will always be a parent, and `out` will always be a child.

```surql
RELATE person:the_nobleman->parent_of->person:wulfield;
```

But with something like a friendship or a marriage we have a bidirectional relationship with equal standing, where it isn't obvious which record should be `in` and which should be `out`. For example, what if the Nobleman and the Bear Knight become best of friends, what then? Should the Nobleman be located at the `in` field of the `friend_of` table, or vice versa?

```surql
-- This way?
RELATE person:the_nobleman->friend_of->person:bear_knight;
-- Or this way?
RELATE person:bear_knight->friend_of->person:the_nobleman;
```

In this small tale we could have chosen an easy workaround by renaming `married` to `husband_of` or `wife_of`, but marriages tend to vary by era and culture and who knows what marriages are like in Aeon's time. Plus, thinking of marriages as more of a generic relationship will help us learn the current concept better.

Getting back to our concrete example, how do we query a `married` graph table if we `RELATE` from husband to wife in one case, and vice versa in the next?

```surql
// Husband marries wife...
RELATE person:eagle_knight->married->person:adelaide;
// Or wife marries husband
RELATE person:wulfield->married->person:bear_knight;
```

Fortunately, there is one more arrow direction we can choose from in this case, written `<->`. This is a bidirectional operator that traverses both `in` and `out` instead of just one or the other.

To give this operator a try, first we'll marry the four couples in a fairly random fashion.

```surql
RELATE person:eagle_knight->married->person:adelaide;
RELATE person:wulfield->married->person:bear_knight;
RELATE person:bertha->married->person:fish_knight;
RELATE person:the_nobleman->married->person:the_noblewoman;
```

Our `married` graph table now doesn't indicate to us through `in` or `out` who is the husband or the wife.

As a result, the unidirectional `->married->person` query below only tells us who is `in` and `out` on the `married` graph edge, even though the knights and the daughters are married to each other!

```surql
SELECT
    id,
    ->married->person AS married
FROM person;
```

The output from this query is far from ideal. We would like the query starting `FROM person` to show the entire married couple, but because `->married->person` only shows us the path from `in` to `out`, it will only show a result when the query matches the order we used to relate the records. Definitely not the query we want to use in this case!

**Response**

```surql
[
  {
    id: person:adelaide,
    married: []
  },
  {
    id: person:bear_knight,
    married: []
  },
  {
    id: person:bertha,
    married: [
      person:fish_knight
    ]
  },
    -- ... and so on ...
]
```

This is where bidirectional graph querying comes in. Let's change `->` in both cases to `<->`, which will now traverse both `in` and `out`.

```surql
SELECT
    id,
    <->married<->person AS married
FROM person;
```

**Response**

```surql
[
  {
    id: person:adelaide,
    married: [
      person:eagle_knight,
      person:adelaide
    ]
  },
  {
    id: person:bear_knight,
    married: [
      person:wulfield,
      person:bear_knight
    ]
  },
  -- ... and so on ...
```

This is looking somewhat better. There is some duplication in the results because it ends up finding both participants in the marriage, which includes the original person record we started the query from. We'll fix that soon.

But first, let's make sure that we understand exactly how we got these results. The query above does the following:

- Starts with a `person` record,

- Checks both `in` and `out` of the `married` graph edge via `<->`. It finds the `person` record at one of them and follows this path.

- Inside, it sees `person` records at both `in` and `out`. The `<->` operator tells it to return both of them.

We can demonstrate this behaviour a bit more by changing `<->married<->person` into two other forms that *won't* work as intended: `->married<->person` and `<->married->person`. Look at the arrows before we try these queries out and think about why they won't work.

Using `->married<->person`:

```surql
SELECT
    id,
    ->married<->person AS married
FROM person;
```

This query won't work, because `->married` only follows the `in` part of `married`, and not all of our married characters are connected via `in`.

**Response**

```surql
[
  {
    id: person:adelaide,
    married: []
  },
  {
    id: person:bear_knight,
    married: []
  },
  {
    id: person:bertha,
    married: [
      person:bertha,
      person:fish_knight
    ]
  },
    // ... and so on ...
```

Using `<->married->person`:

```surql
SELECT
    id,
    <->married->person AS married
FROM person;
```

This query won't work in a different way. While `<->married` does check to see if the `person` record is either an `in` or an `out` on the `married` graph edge, it then only accesses `out` on the way out via `married->person`. But the person we started the query might be located at `out`. As a result, it now looks like Adelaide has gotten married to Adelaide, and the Bear Knight to the Bear Knight!

**Response**

```surql
[
  {
    id: person:adelaide,
    married: [
      person:adelaide
    ]
  },
  {
    id: person:bear_knight,
    married: [
      person:bear_knight
    ]
  },
  {
    id: person:bertha,
    married: [
      person:fish_knight
    ]
  },
    -- ... and so on ...
]
```

So `<->married<->person` is definitely the way to go. However, how can we filter out the response so that we can see just the person along with the person's spouse instead of this?

**Response**

```surql
{
    id: person:adelaide,
    married: [
        person:eagle_knight,
        person:adelaide
    ]
}
```

We can use a little query magic here, starting with a function called `array::complement`. This function returns whatever values are *not* shared between two arrays. Here is a quick example:

```surql
RETURN [1,2,3,4,5].complement([2,3,4]);
RETURN array::complement([person:eagle_knight, person:adelaide], [person:eagle_knight]);
```

**Response**

```surql
[1, 5]
[person:adelaide]
```

And since `<->married<->person` returns an array of record IDs, we can put that inside the `array::complement` function. Note that the query below encloses `id` in an array by changing it to `[id]`.

```surql
SELECT
    id,
    array::complement(<->married<->person, [id]) AS partner
FROM person;
```

**Response**

```surql
[
  {
    id: person:adelaide,
    partner: [
      person:eagle_knight
    ]
  },
  {
    id: person:bear_knight,
    partner: [
      person:wulfield
    ]
  },
  {
    id: person:bertha,
    partner: [
      person:fish_knight
    ]
  },
    -- ... and so on ...
]
```

Finally, we can flatten the structure a bit by using 0 to pull out the first item.

```surql
SELECT
    id,
    array::complement(<->married<->person, [id])[0] AS partner
FROM person;
```

**Response**

```surql
[
  {
    id: person:adelaide,
    partner: person:eagle_knight
  },
  {
    id: person:bear_knight,
    partner: person:wulfield
  },
  {
    id: person:bertha,
    partner: person:fish_knight
  },
  {
    id: person:eagle_knight,
    partner: person:adelaide
  },
  {
    id: person:fish_knight,
    partner: person:bertha
  },
  {
    id: person:the_nobleman,
    partner: person:the_noblewoman
  },
  {
    id: person:the_noblewoman,
    partner: person:the_nobleman
  },
  {
    id: person:wulfield,
    partner: person:bear_knight
  }
]
```

As far as queries go, that's not too bad. But there are some improvements we could make such as finding a way to ensure that you can't marry a couple through one `person` on one side, and then again on the other. Because at the moment the following two `RELATE` statements are still possible:

```surql
-- Bertha marries the Fish Knight...
RELATE person:bertha->married->person:fish_knight;
-- And then the Fish Knight marries Bertha again!
-- This weird double marriage should not be allowed to happen
RELATE person:fish_knight->married->person:bertha;
```

We'll give that a try in the next chapter, along with some longer relational queries.

Practice time

Here are the original records and the new data:

```surql
CREATE building:1 SET name = "Toria town hall";
CREATE building:2 SET name = "Toria castle";
CREATE building:3 SET name = "Toria merchants' guild";
LET $data = [
  { id: 1, name: "Toria town hall", floors: 3  },
  { id: 2, name: "Toria castle",    floors: 10 },
  { id: 3, name: "Toria merchants' guild", floors: 1 },
];
```

Answer

It looks like the new data includes all the existing `id` and `name` fields, plus extra data for `floors`. So in this case `UPSERT` is one option:

```surql
CREATE building:1 SET name = "Toria town hall";
CREATE building:2 SET name = "Toria castle";
CREATE building:3 SET name = "Toria merchants' guild";
LET $data = [
  { id: 1, name: "Toria town hall", floors: 3  },
  { id: 2, name: "Toria castle",    floors: 10 },
  { id: 3, name: "Toria merchants' guild", floors: 1 },
];
FOR $item IN $data {
    UPSERT type::record("building", $item.id) CONTENT $item;
};
```

But `INSERT` will work as well.

```surql
CREATE building:1 SET name = "Toria town hall";
CREATE building:2 SET name = "Toria castle";
CREATE building:3 SET name = "Toria merchants' guild";
LET $data = [
  { id: 1, name: "Toria town hall", floors: 3  },
  { id: 2, name: "Toria castle",    floors: 10 },
  { id: 3, name: "Toria merchants' guild", floors: 1 },
];
INSERT INTO building $data ON DUPLICATE KEY UPDATE floors = $input.floors;
```

### 2. In which case will only INSERT be the right choice, and not UPSERT?

Answer

Thanks to `ON DUPLICATE KEY UPDATE`, `INSERT` will usually be the right choice if you need complex logic that compares an existing record to the attempted new one.

The following example shows a `note` being added if a building's `floors` data is changed, and is not `NONE`.

```surql
CREATE building:1 SET name = "Toria town hall", floors = 3;
CREATE building:2 SET name = "Toria castle", floors = 9;
CREATE building:3 SET name = "Toria merchants' guild";
LET $data = [
    { id: 1, name: "Toria town hall", floors: 3  },
    { id: 2, name: "Toria castle",    floors: 10 },
    { id: 3,                          floors: 1  }
];
INSERT INTO building $data ON DUPLICATE KEY UPDATE
    note =
        IF floors IS NOT NONE AND floors != $input.floors { "Changed from " + <string>floors + " floors to " + <string>$input.floors }
        ELSE { NONE },
    floors = $input.floors;
```

As we saw in an example in this chapter, make sure not to update `floors` until after `notes` is set! Because otherwise `floors` and `$input.floors` will always be the same number.

### 3. Is it possible to create a relation with an ID that is the output of a function?

Answer

Yes, by using the INSERT RELATION statement. Here is one quick example that uses an ID that is a random datetime:

```surql
INSERT RELATION INTO likes { in: cat:one, out: cat:two, id: <string>rand::time() };
```

### 4. Would you need to use the `<->` syntax for a relation query on a table called `wrote`?

Answer

No, as this is clearly a relation with a writer and something that is being written. As such, the final two queries in the example below will return the same output whether you use `->` or `<->`.

```surql
CREATE person:one;
CREATE article:one;
RELATE person:one->wrote->article:one;
SELECT ->wrote FROM person;
SELECT <->wrote FROM person;
```

### 5. What about for a relation query on a table called `likes`?

Answer

Maybe, depending on how you set up your schema and assertions. But if you are working with something that is schemaless in which Record A can relate itself to Record B and vice versa, you will want to use `<->` such as in this simple example.

```surql
CREATE person:one;
CREATE person:two;
RELATE person:one->likes->person:two;
RELATE person:two->likes->person:one;
SELECT
    id,
    <->likes->person.complement([id]) AS friends
FROM person;
```
