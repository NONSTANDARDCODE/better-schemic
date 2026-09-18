# Chapter 5: A long road to travel

**Time elapsed: 2w**

> *You are feeling a little frustrated today.*

> *Whenever you learn a new skill, the first stage is all newness and excitement. But the stage that follows isn't so exciting. It's when you realise just how much you don't know, and how gigantic the task ahead of you is.*

> *You still can't see how your new skills will let you rebuild the world as it once was. All you can do is work with records. And each field can hold any type of data at all. How can software that relies on predictable data know what to do with it?*

> *And what about records that are related to each other? How do you query records that should be connected in some way? Shouldn't you be able to query a `town` and find all its people too without needing a separate query?*

> *It feels like you are missing out on something important.*

> *Looking up, you remember the pictures from one of the books that has given you such comfort during this time.*

![A scene from a German folk tale featuring a king on his throne dressed almost entirely in red, seemingly distracted.](/assets/static/part-0-king.uH8cy2uw.avif)

> *The people of the old world were so good at combining precision with beauty, at blending technology and art. How did they do it?*

> *You take a sip of tea, put your feet up on the desk, and close your eyes. Hmm....*

> *...*

> *A few minutes pass. Suddenly your stubbornness kicks in, and you begin to feel better. There must be a way! The databases made by the ancients must have had easy ways to join related records. There's no way that they built such miracles without technology that was well designed. All you have to do is keep learning, and you'll find the answer.*

> *And in the meantime, why not make the process a little more fun? You open up one of the books and start reading the story. Perhaps the characters inside will give you some ideas for how to build something real this time.*

## Schema and relations

With our introduction to SurrealDB behind us, we are going to move on to a small project that takes place over the next four chapters. We are going to follow along with Aeon who is reading through a story called [The Enchanted Knights](https://en.wikisource.org/wiki/The_Enchanted_Knights) in the hopes of learning how to work with data that is more predictable and more closely linked.

The story will provide Aeon (and us) with a framework in which we have some real data with some complexity to represent.

Let's start reading the story to see what ideas it gives us. It begins with a single character:

> There was once a rich nobleman who lived like a king. He spent his days celebrating and enjoying his vast fortune, and all who came to his parties were given the best food and entertainment.

Let's stop right there, as we already have some decisions to make. How should we represent this character? A `person` table sounds good, but should we choose our own ID, like this?

```surql
CREATE person:the_nobleman;
```

Generally, we would not. Custom IDs in SurrealDB are most useful when we want to iterate over or use them somehow, such as when using record range queries that we saw once and will learn more about in Chapter 10:

```surql
CREATE |event:1..=10| SET ...
SELECT * FROM event:1..=5;
```

However, we are going to learn a lot of new syntax in these chapters, and using human-readable IDs will allow us to simplify the syntax and avoid having to use `WHERE` clauses like in `FROM person WHERE name = "The Nobleman"` as opposed to just `FROM person:the_nobleman`. So we will go with predictable instead of random IDs.

Having decided that, let's give this character a few fields to start:

```surql
CREATE person:the_nobleman SET
    name = "The Nobleman",
    class = "Count",
    money = 100000; --  Just a made-up number
```

So far so good. Now let's read the next sentence in the story.

> In doing so, he wasted his money, and eventually lost his fortune...

Oh no! The poor man.

Updating his money is fairly easy: all we need to do is use the `UPDATE` keyword, followed by `SET` for the `money` field.

```surql
CREATE person:the_nobleman SET name = "The Nobleman", class = "Count", money = 100000;
UPDATE person:the_nobleman SET money = 50;
```

**Response to UPDATE statement**

```surql
[
    {
        class: 'Count',
        id: person:the_nobleman,
        money: 50,
        name: 'The Nobleman'
    }
]
```

This works well, but remember Aeon's concern about predictable data? At the moment SurrealDB lets us set fields on the `person` table to anything at all! We could have done this instead.

```surql
CREATE person:the_nobleman SET name = "The Nobleman", class = "Count", money = 100000;
UPDATE person:the_nobleman
-- Whoops, updated with weather data
SET money = {
    temperature: 15.5,
    location: "Toria"
};
```

**Response to UPDATE statement**

```surql
[
  {
    class: 'Count',
    id: person:the_nobleman,
    money: {
      location: 'Toria',
      temperature: 15.5f
    },
    name: 'The Nobleman'
  }
]
```

And now we'll get an error if we try to update the Nobleman with a bit of extra money later on.

```surql
CREATE person:the_nobleman SET name = "The Nobleman", class = "Count", money = 100000;
UPDATE person:the_nobleman SET money = { temperature: 15.5, location: "Toria" };
UPDATE person:the_nobleman SET money = money + 10;
```

**Response to UPDATE statement**

```surql
"Cannot perform addition with '{ location: 'Toria', temperature: 15.5f }' and '10'"
```

This is exactly what Aeon was worried about. We already have an idea of what a `person` table's fields should and shouldn't be, so let's put a schema together to ensure that abnormal behaviour doesn't happen.

## Schema basics

Do you remember the `INFO FOR DB` statement we learned in the first chapter? Inside the output for this statement is a list of tables. One was automatically created for us after the `CREATE person` statement above, showing that it has no defined schema:

```surql
tables: {
  person: 'DEFINE TABLE person TYPE ANY SCHEMALESS PERMISSIONS NONE',
}
```

At this point, there are two ways to make our schema more strict.

- Defining a table as SCHEMAFULL. This is the most strict method. After a table is made SCHEMAFULL, fields can only be added through DEFINE FIELD statements.

- Only using DEFINE FIELD statements. This defines the fields of a table one at a time, but leaves the table itself schemaless.

We'll choose the first method so that we can understand how SurrealDB works at this stricter point.

Making the `person` table schemafull is easy: all we need is a simple [DEFINE TABLE](/docs/reference/query-language/statements/define/table) statement.

Let's try copying and pasting the statement we saw in the `INFO FOR DB` statement but changing `SCHEMALESS` TO `SCHEMAFULL`.

```surql
CREATE person;
DEFINE TABLE person TYPE ANY SCHEMAFULL PERMISSIONS NONE;
```

Close, but not quite! The table already exists in the database, so SurrealDB won't let us use `DEFINE` on its own to define it.

```surql
"The table 'person' already exists"
```

Here we have two choices: we can add `OVERWRITE` to the statement to force SurrealDB to accept this as the new definition, or use `ALTER TABLE` followed by the part we want to alter.

```surql
CREATE person;
-- Force a full definition
DEFINE TABLE OVERWRITE person TYPE ANY SCHEMAFULL PERMISSIONS NONE;
-- Or alter the existing one with an extra clause
ALTER TABLE person SCHEMAFULL;
```

And now the `person` table is schemafull!

Here is a quick rundown of the choices that you have when defining a resource like a table. They look like this:

```surql
DEFINE TABLE               person...
ALTER  TABLE               person...
DEFINE TABLE IF NOT EXISTS person...
ALTER  TABLE IF     EXISTS person...
DEFINE TABLE OVERWRITE     person...
```

Each of them is used in different cases. They are:

- Use regular `DEFINE` if you know that a resource doesn't exist yet.

- Use `DEFINE...IF NOT EXISTS` or `ALTER...IF EXISTS` if you want the statement to give up without an error if the resource already exists (for `DEFINE`) or doesn't exist (for `ALTER`).

- Use `DEFINE...OVERWRITE` if it might exist and might not, and you want this to be the definition.

- Use `ALTER` if you know it exists and you want to change it.

And there is no `ALTER...OVERWRITE` because `ALTER` itself is a statement that overwrites.

This book uses `DEFINE...OVERWRITE` for the most part, because it's good practice when learning to read the syntax of a statement in full. `ALTER` is more useful when you are building something yourself and need to make a change one day.

Now let's get back to the `person` table. We have made it schemafull, but haven't specified any fields. That makes it incredibly restrictive, because the only field that any `person` record can now have set is `id`, which every record has.

So if we try to create a `person` with a `name` property, will the query work or fail?

```surql
DEFINE TABLE OVERWRITE person TYPE ANY SCHEMAFULL PERMISSIONS NONE;
CREATE person SET 
  name = "Random person",
  age = 25,
  other = {
    some: "other",
    random: "data"
  };
```

Interestingly, it works. SurrealDB will simply look over the fields we try to set, not find them in the schema, and return a record with the only field that is currently allowed: an `id`.

**Response**

```surql
[
    {
        id: person:zndj3pw8kqkoth7sa09y
    }
]
```

To allow other fields to be set, we will need to use some `DEFINE FIELD` statements. `DEFINE FIELD` is followed by `ON`, the table name, and then - if you want - `TYPE` with the type a field must be. We'll give this a try:

```surql
CREATE person;
DEFINE TABLE OVERWRITE person TYPE ANY SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD name  ON TABLE person TYPE string;
DEFINE FIELD class ON TABLE person TYPE string;
DEFINE FIELD money ON TABLE person TYPE int;
```

And now we'll try to create our random person again:

```surql
CREATE person SET name = "Random person";
```

**Response**

```surql
'Found NONE for field `class`, with record `person:dqd4znq4rlcqyximul1i`, but expected a string'
```

The new type strictness is pretty nice, but the fields `class` and `money` could be a little more lenient. It's likely that we will start adding `person` records that don't have this information, so let's set the schema so that `class` must be a `string` if it exists, and money must be an `int` if it exists. To do this, we can turn `TYPE string` and `TYPE int` into `TYPE option<string>` and `TYPE option<int>`.

```surql
DEFINE FIELD OVERWRITE class ON TABLE person TYPE option<string>;
DEFINE FIELD OVERWRITE money ON TABLE person TYPE option<int>;
```

The keywords `DEFAULT` and `VALUE` are two other possibilities that you might want to think about when defining a field. `DEFAULT` lets you set a default value, in which case you wouldn't need a type to be an `option`, while `VALUE` simply declares what the value will be.

We wouldn't want to use `VALUE 0` for the `money` field, because then everybody's money would always be set to 0.

```surql
DEFINE FIELD OVERWRITE money ON TABLE person TYPE int VALUE 0;
```

But `DEFAULT 0` could work, which means that everyone gets 0 unless specified otherwise.

```surql
DEFINE FIELD OVERWRITE money ON TABLE person TYPE int DEFAULT 0;
```

However, `option` makes the most sense for us for both of these fields, because we simply might not know a person's class or how much money they have and don't want to force a `person` record to have a value in that case.

With the optional fields in place, we can now create a person who has a name and nothing else.

```surql
DEFINE FIELD name ON TABLE person TYPE string;
DEFINE FIELD OVERWRITE class ON TABLE person TYPE option<string>;
DEFINE FIELD OVERWRITE money ON TABLE person TYPE option<int>;
CREATE person SET name = "Random person";
```

**Response**

```surql
[
  {
    id: person:hnufh8xe74g94y8u0zyy,
    name: 'Random person'
  }
]
```

## Schema assertions

We can make our schema even more strict if we like by adding assertions. Assertions let us check to see if data is the way it should be, while raising an error if it doesn't match our expectations.

For example, you might want to assert that a number is greater than zero, or that a name is less than 30 characters in length.

Assertions can be created by adding `ASSERT` after defining a field. Inside a `DEFINE FIELD` statement you have access to the value of the field through a parameter called `$value`. You also have access to the other fields of the same table through their names.

What sort of assertions would we like to use?

Well, a person's name probably shouldn't be something like "😊". There is a function called `string::is_ascii()` that could work...

```surql
string::is_ascii("😊");
-- false
```

However, limiting names to ASCII only would mean that accented names like "Renée" wouldn't be accepted. Fortunately, there is another function called `string::is_alpha()` that can work here. It will tell us if a string is alphabetic or not.

Now, there is one problem with using this function. Can you see it?

```surql
RETURN "Adrian".is_alpha();
RETURN "Adrian Fahrenheit Ţepeş".is_alpha();
```

**Response**

```surql
true
false
```

A blank space is not an alphabetic character, so the second query returned `false`. To solve this, we have another function called [string::replace()](/docs/reference/query-language/functions/database-functions/string#stringreplace) that can help us. This function takes a string to work on, followed by a string of a pattern to look for, and a third string to replace it with. Let's use it twice to remove spaces and hyphens.

```surql
RETURN "Adrian Fahrenheit Ţepeş".replace(" ", "").replace("-", "");
```

**Response**

```surql
'AdrianFahrenheitŢepeş'
```

And now, all we have to do is follow this output with the original `string::is_alpha()` function! Now names with spaces and hyphens will be recognised as valid input.

```surql
"Adrian Fahrenheit Ţepeş"
  .replace(" ", "")
  .replace("-", "")
  .is_alpha();
"Karl-Theodor Maria Nikolaus Johann Jacob Philipp Franz Joseph Sylvester Buhl-Freiherr von und zu Guttenberg"
  .replace(" ", "")
  .replace("-", "")
  .is_alpha();
```

Finally, we can move this assertion to the `DEFINE FIELD` statement for the `person` table:

```surql
DEFINE FIELD OVERWRITE name ON TABLE person
    TYPE string
    ASSERT $value.replace(" ", "").replace("-", "").is_alpha();
```

Now we aren't permitted to create `person` records with numbers, emojis and anything else that isn't alphabetic:

```surql
DEFINE FIELD OVERWRITE name ON TABLE person
    TYPE string
    ASSERT $value.replace(" ", "").replace("-", "").is_alpha();
CREATE person SET name = '😊';
CREATE person SET name = '11';
CREATE person SET name = '***';
```

All of these return the same error:

```surql
"Found '😊' for field `name`, with record `person:epi0ihio6tg788b7fp15`,
but field must conform to: $value.replace(' ', '').replace('-', '').is_alpha()"
```

Let's make one more assertion for practice: that `money` must be at least zero.

```surql
DEFINE FIELD OVERWRITE money ON TABLE person
    TYPE option<int>
    ASSERT $value >= 0;
```

Fortunately, SurrealDB is smart enough to know that `NONE` must always be an acceptable value for an `option`. Thanks to that, the assertion only needs to be `$value >= 0` and not `$value IS NONE OR $value >= 0`.

With the above assertion we can now make a person with unspecified money, or a person with money, but not a person with negative money.

```surql
DEFINE FIELD OVERWRITE money ON TABLE person
    TYPE option<int>
    ASSERT $value >= 0;
CREATE person:brother SET name = "Brother of Nobleman";
UPDATE person SET money = -1 WHERE name = "Brother of Nobleman";
```

**Response**

```surql
[
  {
    id: person:brother,
    name: 'Brother of Nobleman'
  }
]
'Found -1 for field `money`, with record `person:brother`,
but field must conform to: $value >= 0 OR $value = NONE'
```

## Relations

We learned quite a bit from reading just a single line of the story! It's finally time to get to the next line:

> All he had left was an old castle, his wife, and three daughters: Wulfield, Adelaide, and Bertha.

> The nobleman became unhappy and spent his days inside his empty castle in a bad mood.

This brings us to one of SurrealDB's greatest strengths: relations. Let's first think about the relations that the Nobleman and his relations have.

- He owns one piece of property, a castle.

- He is connected to one woman by being married to her.

- His wife is also an owner of the castle.

- He and his wife are connected to three other women by being their parents.

Visually, the connection between all of these records would look something like this.

![A number of images of the nobleman, his castle, and his wife and daughters, along with arrows showing the relation between them. He is married to one, the parent of three, and owns one piece of property.](/assets/static/part-5-family-relations.DYEgAtzO.avif)

We'll start with the castle. A castle is one type of building, so maybe we could create a `building` table that can be either a castle, or a house, or something else. We don't know much about the Nobleman's castle, but we can make it a building that has a `name` and a `kind`:

```surql
CREATE building:old_castle SET
  name = "Old castle",
  kind = "castle";
```

**Response**

```surql
[
  {
    id: building:old_castle,
    kind: 'castle',
    name: 'Old castle'
  }
]
```

Since we know how to define a table and its fields, let's do that here. First we will define the table as `SCHEMAFULL` and define its `name` field:

```surql
DEFINE TABLE OVERWRITE building SCHEMAFULL;
DEFINE FIELD name ON TABLE building TYPE string;
```

Next is the `kind` field. It would be nice to ensure that this kind can only be a certain value, like a `house`, `castle`, and so on. We wouldn't like to have a `building` that has `"cat"` or `'2025-12-24T05:31:17.715Z'` as its building kind.

We can do that by using the built-in `CONTAINS` or `IN` keywords, which are mirror images of each other.

```surql
RETURN ["cat", "dog"] CONTAINS "dog";
RETURN "dog" IN ["cat", "dog"];
```

**Response**

```surql
true
true
```

Knowing this keyword, we can define our `kind` field:

```surql
DEFINE FIELD kind ON TABLE building
    TYPE string
    ASSERT ["house", "castle"] CONTAINS $value;
```

As planned, we are now unable to create a building that is a cat!

```surql
CREATE building SET
    name = "Mr. Meow",
    kind = "Cat";
```

**Response**

```surql
"Found 'Cat' for field `kind`, with record `building:wwpx5cuxszrrx3pa6te7`,
but field must conform to: ['house', 'castle'] CONTAINS $value"
```

Now for the interesting part. How do we link the Nobleman (a `person`) to the castle (a `building`)?

In SurrealDB, there are two main ways to do this. The first method is to use record links.

## Record links

A record link in SurrealDB is pretty simple: it's a field that contains one or more record IDs. If you have a record with such a field, you can directly access the records it links to and the data inside, just as if they were all a single record.

Let's give this a try with two schemaless tables first, a `cat` and its two types of `catfood`.

First we'll create the two types of cat food:

```surql
CREATE catfood:dry SET name = 'Dry food';
CREATE catfood:wet SET name = 'Wet food';
```

And then a `cat` that is linked to them. The linking couldn't be easier!

```surql
CREATE cat SET
  name = "Mr. Meow",
  foods = [catfood:dry, catfood:wet];
```

**Response**

```surql
[
  {
    foods: [
      catfood:dry,
      catfood:wet
    ],
    id: cat:gskuz7cevga8cq30hhp2,
    name: 'Mr. Meow'
  }
]
```

The foods will now show up in a query in the same way that another field will.

```surql
SELECT name, foods FROM cat;
```

**Response**

```surql
[
  {
    foods: [
      catfood:dry,
      catfood:wet
    ],
    name: 'Mr. Meow'
  }
]
```

We can also use the `.` operator to walk these links and access their fields too. As you can see, adding record links is almost like turning multiple records into a single record.

```surql
SELECT name, foods.name FROM cat;
```

**Response**

```surql
[
  {
    foods: {
      name: [
        'Dry food',
        'Wet food'
      ]
    },
    name: 'Mr. Meow'
  }
]
```

Note that `foods.name` has maintained the path we took to reach that information: first through "foods", then into "name", which finally leads to an array of strings. If you want to collapse this structure, you can use the `AS` keyword to create an alias.

```surql
SELECT
    name,
    foods.name AS foods
FROM cat;
```

And now both `foods` and `name` are on the same top level.

**Response**

```surql
[
  {
    foods: [
      'Dry food',
      'Wet food'
    ],
    name: 'Mr. Meow'
  }
]
```

So that was how to create record links when we don't have a schema. But with our SCHEMAFULL `person` record, we will need to define this field ahead of time. What type should we give it? Let's think:

- Not everybody owns property, so it should be an `option`.

- People can have more than one property, so we want an array.

- And the type name for record IDs is `record<table_name>`, so this array will hold a number of `record<building>`.

All together, that means an `option<array<record<building>>>`. The type name is a bit long, but just means "multiple `building` IDs that might or might not exist". The definition looks like this:

```surql
DEFINE FIELD properties ON TABLE person TYPE option<array<record<building>>>;
```

With that done, we can now link the Nobleman to his one lonely castle. All we have to do is put the castle ID inside an array and we are done!

```surql
UPDATE person:the_nobleman SET properties = [building:old_castle];
```

Now let's do a query on the Nobleman to show the pitiful state that he is in.

```surql
SELECT
    name,
    money,
    properties.name AS castles
FROM person;
```

**Response**

```surql
[
    {
        castles: [
            'Old castle'
        ],
        money: 50,
        name: 'The Nobleman'
    }
]
```

Poor nobleman!

If we want to see every field of the Nobleman's properties, we can use the star operator.

```surql
SELECT
    name,
    money,
    properties.* FROM person;
```

The star operator works in the same way for an array of records, going through each one and displaying each of its fields. In our case there is only one record inside the `properties` field, but you can see that the output is still an `array<record>`.

```surql
[
  {
    money: 50,
    name: 'The Nobleman',
    properties: [
      {
        id: building:old_castle,
        kind: 'castle',
        name: 'Old castle'
      }
    ]
  }
]
```

Now what if we want to do a search going the other way, by selecting `building` records along with the `person` records that link to them? By default, this information will not show up in a query on `building`, instead only showing its `id`, `kind`, and `name` fields.

```surql
SELECT * FROM building;
```

**Response**

```surql
[
  {
    id: building:old_castle,
    kind: 'castle',
    name: 'Old castle'
  }
]
```

And in earlier versions of SurrealDB, this was the end of the story! Back then, record IDs could only be queried in one direction. Fortunately, this is no longer the case. To make it possible for a linked record to find incoming record links, just add the keyword `REFERENCE` to the end of the `DEFINE FIELD` statement. Adding the keyword `REFERENCE` is like turning on a radio signal that other tables can pick up if they want to tune in.

Tables that are referenced can use an interesting syntax that looks like `<~` to find them. The `~` part looks sort of like a radio wave, while the `<` part represents an arrow pointing inwards, signifying incoming references. This is followed by a table name, such as `<~person`. The `<~person` syntax means "all incoming references from `person` records".

To see references from more than one table, you can enclose their names inside parentheses, such as `<~(person, cat)`. And to look for references from all tables, you can use `?` as a wildcard operator.

Summing it up, that gives us three possibilities.

- `<~person`: all incoming references from `person` records.

- `<~(person, cat, dog)`: all incoming references from `person`, `cat`, or `dog` records.

- `<~?`: all incoming references from any table.

Let's give this a try with `building:old_castle` to see who owns it.

```surql
DEFINE FIELD properties ON TABLE person TYPE option<array<record<building>>> REFERENCE;
CREATE building:old_castle SET name = "Old castle", kind = "castle";
CREATE person:the_nobleman SET 
  name = "The Nobleman", 
  class = "Count", 
  money = 50, 
  properties = [building:old_castle];
SELECT 
  *, 
  <~? AS owners
FROM ONLY building:old_castle;
SELECT 
  *, 
  <~?.* AS owner_details
FROM ONLY building:old_castle;
```

**Response**

```surql
-------- Query --------
{
  id: building:old_castle,
  kind: 'castle',
  name: 'Old castle',
  owners: [
    person:the_nobleman
  ]
}
-------- Query --------
{
  id: building:old_castle,
  kind: 'castle',
  name: 'Old castle',
  owner_details: [
    {
      class: 'Count',
      id: person:the_nobleman,
      money: 50,
      name: 'The Nobleman',
      properties: [
        building:old_castle
      ]
    }
  ]
}
```

That's pretty convenient! We'll keep the `REFERENCE` keyword for the `properties` field so that we can query in both directions from now on.

## `COMPUTED` fields

If you want incoming record links to show up in every query, you can define a field that uses this syntax. Let's give it a try with the `VALUE` keyword, which in fact is the wrong keyword to use in our case.

```surql
DEFINE FIELD owner_details ON TABLE building VALUE <~person.*;
```

The reason why it's the wrong keyword for us is that a `VALUE` is only recalculated whenever a record is created or updated. So if we create `building:old_castle` and then reference it from `person:the_nobleman`, nothing will show up!

```surql
DEFINE FIELD properties ON TABLE person TYPE option<array<record<building>>> REFERENCE;
DEFINE FIELD owner_details ON TABLE building VALUE <~person.*;
CREATE building:old_castle SET name = "Old castle", kind = "castle";
CREATE person:the_nobleman SET 
  name = "The Nobleman", 
  class = "Count", 
  money = 50, 
  properties = [building:old_castle];
SELECT owner_details FROM building;
```

Nothing shows up, because `building:old_castle` didn't have an incoming reference when it was created. The `owner_details` field won't be updated unless we update `building:castle` too.

**Response**

```surql
[{ owner_details: [] }]
```

To fix this, we can use the keyword `COMPUTED` instead of `VALUE`. This will make `owner_details` a field that is never stored. Instead, it will be computed every time a query happens on the `building` table.

```surql
DEFINE FIELD owner_details ON TABLE building COMPUTED <~person.*;
```

With a `COMPUTED` field, the output for the final query will now show the information for the Nobleman without needing to update anything.

**Response**

```surql
[
	{
		owner_details: [
			{
				class: 'Count',
				id: person:the_nobleman,
				money: 50,
				name: 'The Nobleman',
				properties: [
					building:old_castle
				]
			}
		]
	}
]
```

Now, one thing that a record link can't do is contain metadata about the link. For example, you can't do a query like this which sets a record link along with an `owned_since` field that sits in between the `person` and `building` record.

```surql
CREATE person:you 
    SET name = "You", 
    class = "CEO", 
    money = 5000000, 
    property = building:apartment
  -- This part doesn't work
    SET owned_since = d'2025-09-01';
```

If this is your use case, then you'll want to use SurrealDB's second method to link records together called a graph table. This method allows us to create tables based on the *relation* between two tables, and that includes metadata for the relation as well as a really nice querying syntax to move from one node to another.

We will get into that subject in the next chapter as we set up some new links between the Nobleman and his daughters.

## INFO FOR TABLE and properties inside arrays

We'll end the chapter with a quick hint about the `INFO` statement.

In addition to the `INFO FOR DB` statement that we have used a number of times already, there is also `INFO FOR TABLE` that lets us see all of the statements used to define our tables.

Right now, our tables only have a few defined fields. `INFO FOR TABLE building` shows the three fields that we have defined:

```surql
fields: {
  kind: "DEFINE FIELD kind ON building TYPE string ASSERT ['house', 'castle'] CONTAINS $value PERMISSIONS FULL",
  name: "DEFINE FIELD name ON building TYPE string PERMISSIONS FULL",
  owner_details: 'DEFINE FIELD owner_details ON building COMPUTED <~person.* PERMISSIONS FULL'
}
```

Nothing surprising there.

`INFO FOR TABLE person` is a little more interesting, however. Do you notice anything unexpected here? Take a look at the last two statements:

```surql
fields: {
  class: 'DEFINE FIELD class ON person TYPE option<string> PERMISSIONS FULL',
  money: 'DEFINE FIELD money ON person TYPE option<int> ASSERT $value >= 0 OR $value = NONE PERMISSIONS FULL',
  name: "DEFINE FIELD name ON person TYPE string ASSERT $value.replace(' ', '').replace('-', '').is_alpha() PERMISSIONS FULL",
  properties: 'DEFINE FIELD properties ON person TYPE none | array<record<building>> REFERENCE ON DELETE IGNORE PERMISSIONS FULL',
  "properties.*": 'DEFINE FIELD properties.* ON person TYPE record<building> REFERENCE ON DELETE IGNORE PERMISSIONS FULL'
}
```

The `properties` field at the very end contains two statements instead of one! This is expected behaviour, however: here SurrealDB is simply defining a field called `properties` that is an array, along with a `properties.*` field to define the type inside the array.

We can experiment with this a little by quickly creating a SCHEMAFULL table that contains a single field that is an array of an array of an array of an `array<int>`.

```surql
DEFINE TABLE sometable SCHEMAFULL;
DEFINE FIELD lots_of_arrays ON sometable TYPE array<array<array<array<int>>>>;
```

Now let's check the output from `INFO FOR TABLE sometable`. Our single `DEFINE FIELD` has been turned into five `DEFINE` statements! And the statement at the very end is the one that defines the type that the arrays actually contain, a simple `int`.

```surql
DEFINE TABLE sometable SCHEMAFULL;
DEFINE FIELD lots_of_arrays ON sometable TYPE array<array<array<array<int>>>>;
INFO FOR TABLE sometable;
```

```surql
{
	events: {},
	fields: {
		lots_of_arrays: 'DEFINE FIELD lots_of_arrays ON sometable TYPE array<array<array<array<int>>>> PERMISSIONS FULL',
		"lots_of_arrays.*": 'DEFINE FIELD lots_of_arrays.* ON sometable TYPE array<array<array<int>>> PERMISSIONS FULL',
		"lots_of_arrays.*.*": 'DEFINE FIELD lots_of_arrays.*.* ON sometable TYPE array<array<int>> PERMISSIONS FULL',
		"lots_of_arrays.*.*.*": 'DEFINE FIELD lots_of_arrays.*.*.* ON sometable TYPE array<int> PERMISSIONS FULL',
		"lots_of_arrays.*.*.*.*": 'DEFINE FIELD lots_of_arrays.*.*.*.* ON sometable TYPE int PERMISSIONS FULL'
	},
	indexes: {},
	lives: {},
	tables: {}
};
```

These fields marked with `.*` are automatically generated by SurrealDB, so expect to see them in an `INFO FOR TABLE` statement if you have an array. You don't ever have to type them out yourself.

Practice time

Hint

Check SurrealDB's [string functions](/docs/reference/query-language/functions/database-functions/string) to see if you can find a function to do the job.

Answer

The function `string::is_numeric()` will do the job. Calling it on `$value` will have it check the value of the field itself to ensure that the input is all numeric.

```surql
DEFINE FIELD numstring ON TABLE user
  TYPE string
  ASSERT $value.is_numeric();
```

### 2. How would you create a `user` with record links to the comments (a table `comment`) that it wrote?

Answer

You could do this by creating a `user`, then a `comment` record and then updating it. You could use the `+=` syntax which will be recognised as an array, or outright create an array by putting the comment inside `[]`.

```surql
CREATE user:one SET name = "One";
CREATE comment:one SET content = "Go local sports team!";
UPDATE user:one SET comments += comment:one;
// Or:
UPDATE user:one SET comments = [comment:one];
SELECT name, comments.content AS comments FROM user;
```

### 3. For some reason you wanted a table that can only hold a simple ID, but then noticed that it can still hold complex data.

```surql
DEFINE TABLE no_data SCHEMAFULL;
CREATE no_data:["actually", "has", "lots", "of", "daaaataaaa"];
```

What can you do?

Answer

Since complex record IDs are either objects or arrays, we can assert that an ID is not either of these types. Note the `!` in front of the function, which means "not".

The function `record::id()` gives us access to the id part of the record ID, while the functions `type::is_object()` and `type::is_array()` let us ensure that this id isn't either of these two types.

```surql
DEFINE FIELD id ON no_data
    ASSERT
        !$value.id().is_object() AND !$value.id().is_array();
```

### 4. If you had a `person` table with the fields `first_name` and `last_name`, how could you automatically generate a `full_name` using them?

Answer

Since `DEFINE FIELD` gives access to the parent table, we can use that.

```surql
DEFINE FIELD first_name ON TABLE person TYPE string;
DEFINE FIELD last_name  ON TABLE person TYPE string;
DEFINE FIELD full_name  ON TABLE person VALUE first_name + ' ' + last_name;
```

### 5. Is there a limit to the number of record IDs you can traverse via record links?

Answer

Nope! As long as there is data at the end of the path, there is no limit to the number of `.` used to reach it.

For a fun demonstration, see the code below that creates ten people and gives each of them two friends. The function `rand::enum()` is used here to make a random pick from the elements of an array.

```surql
CREATE |person:1..=5|;
FOR $person IN SELECT id FROM person {
    LET $all_people = (SELECT VALUE id FROM person);
    UPDATE $person SET friends += rand::enum($all_people);
    UPDATE $person SET friends += rand::enum($all_people);
};
```

Once they are created, you can see their friends, their friends' friends, and friends' friends' friends, and so on.

```surql
SELECT id,
    friends,
    friends.friends AS second_degree,
    friends.friends.friends AS third_degree
    FROM person;
```

This code was meant to be as easy as possible to read in this early chapter. For a challenge, see if you can find out how to only allow people to be friends with one person once, and to disallow people being friends with themselves.
