# Chapter 17: Landevin&#x27;s journey

**Time elapsed: 49y**

> *You slam your car door shut, stand up and stretch. It's late night, and you've just returned from a trip outside. The world has been abuzz with news about a comet in the sky, and you've just had a look. The city of Toria has grown and is now quite bright at night, so you had to take your car to a darker location to view it. But once there, you were able to view it in its full splendour.*

> *Although you have focused on objective data your whole life, the old superstition about comets as omens of bad luck makes you feel uneasy. And even after so many years you still to live as you always did, outside of the tunnel compound and under the open sky.*

> *You notice a number of calls from world leaders that arrived while you were out, but your eyes are drawn to a message from Landevin. He has spent the past years travelling from country to country beyond Europe to work on the formula you discovered so long ago. Apparently it requires a lot of data on humanity as a whole, and that means visiting as many places as possible to refine the data. Despite the progress over the past 49 years, many places are still off the grid and nothing beats going to the field in person to find the information.*

> *How nice it must be to travel so much! You smile as you wonder if Landevin is really working hard on solving the formula as he says, or whether he's just enjoying seeing the world in his old age. Maybe a bit of both?*

## Advanced queries

We are nearing the end of the book, congratulations for getting this far! We are going to continue with a few more query hints in this chapter, this time focused on the operators and patterns that tend to look somewhat intimidating. Near the end, we will even delve into SurrealDB's source code a little. You can think of this chapter as a collection of SurrealDB "black magic" and insights into its inner workings.

## Operators and truthiness

SurrealDB has [quite a few operators](/docs/reference/query-language/language-primitives/operators), most of which we have already encountered throughout the book and which are familiar to almost everyone who has used a database before: +, -, AND, IS, >=, and so on.

Some operators, however, such as those composed of two characters like `?=` and `??`, are less obvious. The concept of "truthiness" is important when it comes to understanding how many of them work.

### Truthiness and the ! and !! operators

The ! operator is often used in programming languages to reverse a boolean, in a form like the following pseudocode:

```surql
fn user_exists() { // Some function to check if a user exists
  // Code to check if user exists
}
if !user_exists() { // If user does not exist...
  // Code to sign up a new user
}
```

A few other languages, including SurrealQL, take this a step further by giving every value a 'truthiness'. Truthiness is based on whether a value is not NONE, not NULL, or not its default value.

Here is a simple example of six values with a truthiness of false. Note that even values like `""`, `0`, and `[]` are considered to be non-truthy. With the ! operator in front, they will now return the opposite: `true`.

```surql
RETURN [!NONE, !NULL, !"", ![], !{}, !0];
```

**Response**

```surql
[
  true,
  true,
  true,
  true,
  true,
    true
]
```

Similarly, you can double the operator to `!!` which serves as a nice short form of "is not empty, or NONE, or NULL". As a result, the following query will return `true`.

```surql
RETURN !!"Not empty";
```

We can put together a quick function that returns any value it receives and also whether it is truthy or not. The `any` type here allows us to accept any and all values.

```surql
DEFINE FUNCTION fn::is_truthy($input: any) -> { input: any, is_truthy: bool } {
  RETURN { input: $input, is_truthy: !!$input };
};
RETURN [
    fn::is_truthy(""),
    fn::is_truthy([]),
    fn::is_truthy({}),
    fn::is_truthy(NONE),
    fn::is_truthy(NULL),
    fn::is_truthy(0),
    fn::is_truthy("Not empty"),
    fn::is_truthy({
        empty: "No"
    }),
    fn::is_truthy(1)
];
```

**Response**

```surql
[
  {
    input: '',
    is_truthy: false
  },
  {
    input: [],
    is_truthy: false
  },
  {
    input: {},
    is_truthy: false
  },
  {
    input: NONE,
    is_truthy: false
  },
  {
    input: NULL,
    is_truthy: false
  },
  {
    input: 0,
    is_truthy: false
  },
  {
    input: 'Not empty',
    is_truthy: true
  },
  {
    input: {
      empty: 'No'
    },
    is_truthy: true
  },
  {
    input: 1,
    is_truthy: true
  }
]
```

Let's think about where we might have been able to use this `!!` operator.

Back in Chapter 9 we looked at the various degrees of strictness in SurrealDB and how to work with optional fields. This next example is a simplified example of one of them, in which a `building` record has a field called `location` that is an `option<string>` that also contains an assertion for length.

As a result, this field can be unset, a string, or an empty string. But it can't be NULL, as `option<string>` is defined as either `NONE` or a `string`, not `NULL`.

```surql
DEFINE FIELD location ON TABLE building
  TYPE option<string>
  ASSERT $value.len() < 50;
CREATE building;
CREATE building SET location = "Central Toria next to Mayor's House";
CREATE building SET location = "";
// Won't work
CREATE building SET location = NULL;
```

This field could be defined in a looser fashion by removing the `option<string>` using the `!` operator. The `ASSERT !$value OR...` part here effectively means "ASSERT that $value` is not truthy, or a string less than 50 characters long".

```surql
DEFINE FIELD location ON TABLE building
  ASSERT !$value OR string::len($value.len) < 50;
CREATE building;
CREATE building SET location = "Central Toria next to Mayor's House";
CREATE building SET location = "";
CREATE building SET location = NULL;
// Won't work as string::len() expects a string
CREATE building SET location = 10;
```

Note that while the second example is a bit more flexible, it is trickier to read. And without a `TYPE string` in the definition, SurrealDB Studio won't be able to visually represent the type in the Designer view.

Similarly, using `!!$value` inside a field definition is a bit similar to using `TYPE any`, except that empty values and `NULL` are not accepted. Note the difference below in which the fields `identifier` and `metadata` can't be set to the empty or default values, as they are not truthy.

```surql
DEFINE FIELD identifier ON TABLE building ASSERT !!$value;
DEFINE FIELD metadata   ON TABLE building ASSERT !!$value;
CREATE building SET
    identifier = 1, // 0 won't be accepted
    metadata = { floors: 2 };  // {} won't be accepted
```

### `??` and `?:` for default values

These two operators are the ones to use when you would like to return a default value in case a value doesn't exist. They have slightly different behaviour, which the examples below will make clear.

The first one is `??`, which is known as the coalescing operator. It checks to see if the value on the left is truthy and not null. If so then it will return the value on the left, and otherwise it will return the value on the right.

Take the following two `person` records for example. One is Aeon, who does not have a full name, and the second is a `cat` who does have a full name. We can use the `??` operator here to return `full_name` if it exists, and `name` otherwise.

```surql
DEFINE FIELD name ON TABLE person TYPE string;
CREATE person:aeon   SET name = "Aeon";
CREATE person:johnny SET name = "Johnny", full_name = "Johnny Johnclaw McJohnson";
SELECT VALUE full_name ?? name AS name FROM person;
```

As a result, we might see the `full_name` of these two records, but if not, we are guaranteed to at least see their `name`.

```surql
[
  'Aeon',
  'Johnny Johnclaw McJohnson'
]
```

The `?:` operator has similar behaviour, except that it counts default values like "" and 0 as not truthy even if they exist. This operator is technically known as the "Ternary conditional operator", but you can also think of it as the "treat empty values as NONE operator".

The example below with two banks that each have two vaults shows where this operator might come in handy. Each bank chooses the first fault as the day's source of funds if there is money inside, and the second vault otherwise. In this case, you would want to use `?:` instead of `??`.

```surql
CREATE bank:one SET vault_one_funds = 0,  vault_two_funds = 100;
CREATE bank:two SET vault_one_funds = 50, vault_two_funds = 100;
SELECT vault_one_funds ?? vault_two_funds AS vault_funds FROM bank;
SELECT vault_one_funds ?: vault_two_funds AS vault_funds FROM bank;
```

You can see in the query output that the `??` operator is not what we would want in this case, as it returns `0` for the day's source of funds even though `bank:one` has 100 in funds in its second vault. But `?:` will default to the second vault if the first one has a value of 0, which makes it the right choice here. You'll find yourself using `?:` a lot when dealing with data that uses empty strings to represent no value.

```surql
-------- Query --------
[
  {
    vault_funds: 0
  },
  {
    vault_funds: 50
  }
]
-------- Query --------
[
  {
    vault_funds: 100
  },
  {
    vault_funds: 50
  }
]
```

### Using `?` to break early in case of NONE or NULL

While we are at it, there is another usage of the `?` that we should probably take a look at that is useful when it comes to mapping and filtering operations.

The query below takes an array of strings, removes all letters except the vowels, joins them back into a vowel-only word, and checks its length. In other words, it counts the number of vowels in each string.

```surql
LET $words = ['Comets', 'are', 'bodies', 'of', 'dust', 'and', 'ice',
              'commonly', 'seen', 'as','bad', 'omens'];
$words
  .map(|$word| $word.split('').filter(|$letter| $letter IN ["a", "e", "i", "o", "u"]))
    .map(|$letter| $letter.join(''))
    .map(|$word| $word.len());
```

**Output**

```surql
[
  2,
  2,
  3,
  1,
  1,
  1,
  2,
  2,
  2,
  1,
  1,
  2
]
```

However, this query will fail if any items in the original data happen to be a `NONE` or `NULL`, because we will then be asking SurrealDB to `string::split()` on a `NONE`, or `string::join()` a `NONE`, or get its length, and so on.

```surql
LET $words = ['Comets', NONE, 'are', 'bodies', 'of', 'dust', 'and', 'ice',
              'commonly', 'seen', 'as','bad', 'omens'];
$words
  .map(|$word| $word.split('').filter(|$letter| $letter IN ["a", "e", "i", "o", "u"]))
    .map(|$letter| $letter.join(''))
    .map(|$word| $word.len());
```

This could be solved by filtering out items that are `NONE`, but sometimes you might want the database to just ignore the function call in this case. We can do this by adding a `.?` to all the areas where calling a function on `NONE` will return an error. In the case of the example above, that means three question marks in total.

```surql
LET $words = ['Comets', NONE, 'are', 'bodies', 'of', 'dust', 'and', 'ice', 'commonly', 'seen', 'as','bad', 'omens'];
$words
  .map(|$word| $word.?.split('').filter(|$letter| $letter IN ["a", "e", "i", "o", "u"]))
    .map(|$letter| $letter.?.join(''))
    .map(|$word| $word.?.len());
```

Doing so will let the original `NONE` slip through without calling `NONE.split('')`, `NONE.join('')`, or `NONE.len()`, all of which would have resulted in an error.

**Response**

```surql
[
  2,
  NONE,
  2,
  3,
  1,
  1,
  1,
  2,
  2,
  2,
  1,
  1,
  2
]
```

## Shadowing and expression output

One interesting and subtle part of SurrealDB's behaviour that you might have noticed is that it is very heavily expression-based. This means that you can not only pass in values, but also things like functions that return values when they are called.

```surql
LET $num = 9;
LET $gives_num = || 9;
LET $num = $gives_num();
```

This is why subqueries are so easy to slip into a regular query, because a query returns an expression that can be captured and used elsewhere. Take the following query for example in which we declare a parameter on the first line that holds a number of `person` records with random `num` values, another parameter that filters them to only include `person` records with positive `num` values, and finally `count()` function to count how many of them there are.

```surql
LET $people = CREATE |person:10| SET num = rand::int();
LET $positives = SELECT * FROM $people WHERE num > 0;
RETURN count($positives);
```

Each of the parameters in the above query are the results of an expression, so the expressions themselves can be put into a single query that holds them as subqueries.

```surql
RETURN count(
    SELECT * FROM (
        CREATE |person:10| SET num = rand::int()
    ) WHERE num > 0
);
```

Another thing to note about expressions is that the last line of a scope is the scope's return value. We can take the same query as above and split it up in just such a way that the last `count()` function call is assigned to a parameter called `$count` which takes its value from the last line of a scope.

```surql
LET $people = CREATE |person:10| SET num = rand::int();
LET $count = {
    LET $positives = SELECT * FROM $people WHERE num > 0;
    count($positives)
};
RETURN $count;
```

Another interesting concept is one called shadowing. Shadowing refers to the ability to reassign a different value to the same parameter name. This is used especially inside internal scopes that are only used to process some operations and return a value that gets assigned to another parameter.

Here is the same example as before except with a parameter called `$res` that gets redefined on a few lines inside a smaller scope and is finally used as the return value of another value, itself called `$res`! SurrealDB is fine with this behaviour.

```surql
LET $people = CREATE |person:10| SET num = rand::int();
// This $res will be an int
LET $res = {
    // This $res is an array<record<person>>
    LET $res = SELECT * FROM $people WHERE num > 0;
  // This $res will be an int
  LET $res = count($res);
    $res
};
RETURN $res;
```

Shadowing is often seen inside `IF ELSE` statements in which a value needs to be checked and/or modified a bit, but there is no particular need for a new parameter name. The example below shows a more real-world situation in which a parameter called `$person` of type `person` is given a check to see if it is `NONE`. If it is `NONE` then a `person` record will be created to ensure that `$person` is actually a `record`, and if not, then the original `$person` (which is guaranteed to not be NONE) will be assigned to the `$person` parameter created on that line.

```surql
CREATE person SET name = "Alexander the Great";
LET $person = SELECT * FROM ONLY person 
  WHERE name = "Alexander the Great"
  LIMIT 1;
LET $person = IF $person IS NONE {
    CREATE ONLY person SET name = "Alexander the Great";
} ELSE {
    $person
};
RETURN $person;
```

## Working with the fields of graph tables to create your own customised behaviour

Being able to set values on graph tables can open up a range of possibilities when it comes to relations that go beyond what we've seen so far in this book and in the SurrealDB documentation. One interesting pattern - discovered by a SurrealDB user - involves replacing multiple relation tables with a single table that contains a number of booleans.

To show this pattern, we will first create a typical example of some relations between a `bank` and `person` records. A person might be a customer of a bank, a regular employee, or even a director. In the queries below we will create a bank called the `first_bank_of_toria` which is related to three people: Aeon, a customer, and an employee. Aeon is both a director and customer of the bank, `person:employee` is an employee and a customer, while `person:customer` is just a customer.

```surql
CREATE bank:first_bank_of_toria, person:aeon, person:customer, person:employee SET name = id.id();
RELATE bank:first_bank_of_toria->customer->[person:aeon, person:customer, person:employee];
RELATE bank:first_bank_of_toria->employee->person:employee;
RELATE bank:first_bank_of_toria->director->person:aeon;
```

Pretty simple! Now let's try the same relations using the technique hinted at above. However, instead of using the three tables called `customer`, `employee`, and `director`, we'll just use a single one called `is_a`.

To determine the relationship a person has with the bank, we will simply set some booleans to `true` where this is the case. The same relations can now be set up as follows.

```surql
CREATE bank:first_bank_of_toria, person:aeon, person:customer, person:employee SET name = id.id();
RELATE person:aeon->is_a->bank:first_bank_of_toria SET
  customer = true,
  director = true;
RELATE person:customer->is_a->bank:first_bank_of_toria SET
  customer = true;
RELATE person:employee->is_a->bank:first_bank_of_toria SET
  employee = true,
  customer = true;
```

What is nice about this technique is how well it fits with the existing SurrealQL syntax. With just a quick `[WHERE relation_name]` inside a query, we can match on the boolean values inside.

```surql
SELECT *,
  <-is_a[WHERE employee].in.* AS people.employees,
  <-is_a[WHERE customer].in.* AS people.customers,
  <-is_a[WHERE director].in.* AS people.directors
FROM bank:first_bank_of_toria;
```

**Response**

```surql
[
  {
    id: bank:first_bank_of_toria,
    name: 'first_bank_of_toria',
    people: {
      customers: [
        {
          id: person:customer,
          name: 'customer'
        },
        {
          id: person:employee,
          name: 'employee'
        },
        {
          id: person:aeon,
          name: 'aeon'
        }
      ],
      directors: [
        {
          id: person:aeon,
          name: 'aeon'
        }
      ],
      employees: [
        {
          id: person:employee,
          name: 'employee'
        }
      ]
    }
  }
]
```

Or you can turn the query around to start with `person` records to determine where they work, direct, or bank at.

```surql
SELECT *,
    ->is_a[WHERE employee].out AS works_at,
    ->is_a[WHERE director].out AS directs,
    ->is_a[WHERE customer].out AS banks_with
FROM person;
```

**Response**

```surql
[
  {
    banks_with: [
      bank:first_bank_of_toria
    ],
    directs: [
      bank:first_bank_of_toria
    ],
    id: person:aeon,
    name: 'aeon',
    works_at: []
  },
  {
    banks_with: [
      bank:first_bank_of_toria
    ],
    directs: [],
    id: person:customer,
    name: 'customer',
    works_at: []
  },
  {
    banks_with: [
      bank:first_bank_of_toria
    ],
    directs: [],
    id: person:employee,
    name: 'employee',
    works_at: [
      bank:first_bank_of_toria
    ]
  }
]
```

And now it's time for the blackest of all black magic when it comes to navigating a database: its source code.

## Navigating the SurrealDB source code

SurrealDB's source code is [out in the open](https://github.com/surrealdb/surrealdb/) for the entire world to see. SurrealDB is written in the Rust programming language, and because as of 2025 Rust tends to show up around 10th place in terms of [most popular programming languages](https://pypl.github.io/PYPL.html), it is most likely that you are a user of a language like JavaScript, Python or Java instead of Rust.

But no problem! Learning how to passively read code is much easier than writing your own, and with a few tips you will be able to skim through the source code to learn a few things on your own that might not be mentioned anywhere else yet. Just keep in mind that the source code is subject to change and represents code for versions of SurrealDB that might not be released yet. Going through the source code is sort of like walking into a company's office and peeking at everybody's monitor: you will get a lot of insight into its inner workings, but will also see a good deal of unfinished or finished but not yet released work. Or even unfinished work that will be reverted and will never see the light of day.

You can download the source code with the command `git clone https://github.com/surrealdb/surrealdb` if you use Git. If you don't use Git, you can still go to `https://github.com/surrealdb/surrealdb` and click on the Code button and then `Download ZIP` to get the source code on your computer. If you aren't a developer and don't want to install an IDE like Visual Studio Code, you could go with something lightweight code viewer like [Sublime Text](http://www.sublimetext.com/). You can then open the folder, right click on it and select `Find in Folder` to do a quick search through the entire codebase.

Now let's learn how to peek at the inner workings of SurrealDB as it is developed.

### Seeing the latest changes

While each SurrealDB version comes with a change log, you can also go to the [tags page](https://github.com/surrealdb/surrealdb/tags) to compare versions for yourself. You can click on any version on the tags page, then on `Compare` to compare the version you selected with a previous version. For example, comparing version 2.0.0-alpha.5 with 2.0.0-alpha.4 takes you to [this page](https://github.com/surrealdb/surrealdb/compare/v2.0.0-alpha.4...v2.0.0-alpha.5), with some pull requests like "Improve RETURN logic" and "Fix peeking in parse_uuid". If you click on the PR for "Improve RETURN logic" then you will find [this page](https://github.com/surrealdb/surrealdb/pull/4298) which includes an explanation of the change made.

```surql
What is the motivation?
The RETURN statement currently works in a strange way where it can alter
the output of a block or transaction, but it will not break execution.
What does this change do?
This PR makes it so that the RETURN statement sets the definitive output
value of custom blocks, functions and transactions, and that it halts
execution of them.
```

### Peeking at tests for extra query examples

While SurrealDB's documentation is extensive and full of examples, the tests in the source code show even more examples of SurrealDB's behaviour.

Unlike many other programming languages, Rust doesn't require you to keep tests in a certain folder. Instead, you can find them by doing a search for the annotation `#[test]`, which will show standard tests, or `#[tokio::test]`, which will show async tests.

Inside tests you will see a lot of the following assertions: `assert!`, `assert_eq!` (assert equal), or `assert_ne!` (assert not equal). Each of these lines will show you what the output must be in order for the test to succeed. And since all the tests must pass for the build to be successful, these lines are guarantees that the output will be what they assert it to be.

Here is one example of a standard test, which evaluates the output of the [array::at()](/docs/reference/query-language/functions/database-functions/array#arrayat) function. You can see an `assert_eq!` inside the code, so the test is expecting two values to be the same.

```surql
  #[test]
  fn array_at() {
    fn test(arr: Array, i: i64, expected: Value) {
      assert_eq!(at((arr, i)).unwrap(), expected);
    }
    test(vec!["hello", "world"].into(), -2, "hello".into());
    test(vec!["hello", "world"].into(), -3, Value::None);
  }
```

As the test shows, calling `array::at(["hello", "world"], -2)` will go to the second index from the end to return the word "hello". But the second test shows another interesting example: passing in an index that is greater than the length of an array will return NONE, not an error. Source code tests are generally of this sort of nature, with many assertions at each step that could be too noisy to put into documentation.

The tests marked with `#[tokio::test]` tend to be more interesting, because they use an async runtime which is used to start an actual database into which queries can be passed. The next example has two tests. The first one is an example of a database that does not have any `DEFINE USER` statements, and thus no users with permissions to use the database. As such, an error should be produced every time the database tries to validate their credentials. The second test is its opposite, showing three SurrealQL statements that properly create users (one each for root, namespace, and database), after which verification succeeds for all of them.

```surql
  #[tokio::test]
  async fn test_verify_creds_invalid() {
    let ds = Datastore::new("memory").await.unwrap();
    let ns = "N".to_string();
    let db = "D".to_string();
    // Reject invalid ROOT credentials
    {
      assert!(verify_root_creds(&ds, "test", "test").await.is_err());
    }
    // Reject invalid NS credentials
    {
      assert!(verify_ns_creds(&ds, &ns, "test", "test").await.is_err());
    }
    // Reject invalid DB credentials
    {
      assert!(verify_db_creds(&ds, &ns, &db, "test", "test").await.is_err());
    }
  }
  #[tokio::test]
  async fn test_verify_creds_valid() {
    let ds = Datastore::new("memory").await.unwrap();
    let ns = "N".to_string();
    let db = "D".to_string();
    // Define users
    {
      let sess = Session::owner();
      let sql = "DEFINE USER root ON ROOT PASSWORD 'root'";
      ds.execute(sql, &sess, None).await.unwrap();
      let sql = "USE NS N; DEFINE USER ns ON NS PASSWORD 'ns'";
      ds.execute(sql, &sess, None).await.unwrap();
      let sql = "USE NS N DB D; DEFINE USER db ON DB PASSWORD 'db'";
      ds.execute(sql, &sess, None).await.unwrap();
    }
    // Accept ROOT user
    {
      let res = verify_root_creds(&ds, "root", "root").await;
      assert!(res.is_ok());
    }
    // Accept NS user
    {
      let res = verify_ns_creds(&ds, &ns, "ns", "ns").await;
      assert!(res.is_ok());
    }
    // Accept DB user
    {
      let res = verify_db_creds(&ds, &ns, &db, "db", "db").await;
      assert!(res.is_ok());
    }
  }
```

Similarly, another piece of code inside a test called `fn check_execute_option_permissions()` goes into quite some detail on exactly what each type of role is able and not able to do.

```surql
let tests = vec![
        // Root level
        (Session::for_level(().into(), Role::Owner).with_ns("NS").with_db("DB"), true, "owner at root level should be able to set options"),
        (Session::for_level(().into(), Role::Editor).with_ns("NS").with_db("DB"), true, "editor at root level should be able to set options"),
        (Session::for_level(().into(), Role::Viewer).with_ns("NS").with_db("DB"), false, "viewer at root level should not be able to set options"),
        // Namespace level
        (Session::for_level(("NS", ).into(), Role::Owner).with_ns("NS").with_db("DB"), true, "owner at namespace level should be able to set options on its namespace"),
        (Session::for_level(("NS", ).into(), Role::Owner).with_ns("OTHER_NS").with_db("DB"), false, "owner at namespace level should not be able to set options on another namespace"),
        (Session::for_level(("NS", ).into(), Role::Editor).with_ns("NS").with_db("DB"), true, "editor at namespace level should be able to set options on its namespace"),
        (Session::for_level(("NS", ).into(), Role::Editor).with_ns("OTHER_NS").with_db("DB"), false, "editor at namespace level should not be able to set options on another namespace"),
        (Session::for_level(("NS", ).into(), Role::Viewer).with_ns("NS").with_db("DB"), false, "viewer at namespace level should not be able to set options on its namespace"),
        // Database level
        (Session::for_level(("NS", "DB").into(), Role::Owner).with_ns("NS").with_db("DB"), true, "owner at database level should be able to set options on its database"),
        (Session::for_level(("NS", "DB").into(), Role::Owner).with_ns("NS").with_db("OTHER_DB"), false, "owner at database level should not be able to set options on another database"),
        (Session::for_level(("NS", "DB").into(), Role::Owner).with_ns("OTHER_NS").with_db("DB"), false, "owner at database level should not be able to set options on another namespace even if the database name matches"),
        (Session::for_level(("NS", "DB").into(), Role::Editor).with_ns("NS").with_db("DB"), true, "editor at database level should be able to set options on its database"),
        (Session::for_level(("NS", "DB").into(), Role::Editor).with_ns("NS").with_db("OTHER_DB"), false, "editor at database level should not be able to set options on another database"),
        (Session::for_level(("NS", "DB").into(), Role::Editor).with_ns("OTHER_NS").with_db("DB"), false, "editor at database level should not be able to set options on another namespace even if the database name matches"),
        (Session::for_level(("NS", "DB").into(), Role::Viewer).with_ns("NS").with_db("DB"), false, "viewer at database level should not be able to set options on its database"),
    ];
```

### Structs, enums, and `#[non_exhaustive]`

Custom data types are made in Rust using the keywords `struct` and `enum`. A `struct` is a collection of parameters (sort of like a record), while an `enum` is a list of possible choices, similar to SurrealDB's literal types. A struct can contain enums, and enums can contain structs.

Rust also has a `#[non_exhaustive]` attribute that is placed on top of these types if there are plans to expand them later on. The Rust compiler uses this attribute to treat these types a little differently, but all we need to know is that this is a hint that the type might change in the future.

Take a look at the following struct and enum and see if they look familiar.

```surql
#[non_exhaustive]
pub struct DbResultStats {
	/// The time taken to execute the query.
	///
	/// Note: This comes from the `time` field of the [`crate::dbs::Response`] struct.
	pub execution_time: Option<Duration>,
}
#[non_exhaustive]
pub enum Role {
  #[default]
  Viewer,
  Editor,
  Owner,
}
```

That's right: the `struct DbResultStats` is the struct used to display the execution time that we've seen in SurrealDB Studio, as well as with the CLI when using the `--pretty` flag. And `enum Role` looks like the three user roles that we learned about in Chapter 15. Both of these are marked with `#[non_exhaustive]`, which *may* be a hint that more fields will be added to `Stats` or that more types of roles will be added. And indeed, the [roles](/docs/reference/query-language/statements/define/user#roles) part of the DEFINE USER page does hint that more roles might be added in the future:

```surql
Roles
Currently, only the built-in roles OWNER, EDITOR and VIEWER are available.
```

Though keep in mind that `#[non_exhaustive]` doesn't necessarily mean that there *will* be any future changes, and it is just as likely that a type will just lose the `#[non_exhaustive]` one day if the decision is made to keep it unchanged. So when you see this attribute, just think of it as *may be* modified in the future!

### Viewing external dependencies inside Cargo.toml

Each Rust project is based around one or more Cargo.toml files, inside which you can see its dependencies. Dependencies are external libraries (known as crates) with code that can be used instead of having to implement everything yourself. The most interesting Cargo.toml file for SurrealDB is inside the `core` folder. Under the dependencies section in this file, you can see quite a few recognizable names such as `base64` and `geo`, while one called `fuzzy-matcher` seems to be the crate used for the fuzzy matching that we learned in this very chapter.

Each of these are hosted on the website `crates.io` using the same name, so they are easy to find. If we look at [the page for the geo crate](https://crates.io/crates/geo) we can see an introduction to the crate, as well as a recommendation to [check out the complete documentation](https://docs.rs/geo/latest/geo/) for more. Inside the complete documentation we see a large number of options for calculating area, distance, and bearing.

- *Area*

- *Area: Calculate the planar area of a geometry*

- *ChamberlainDuquetteArea: Calculate the geodesic area of a geometry on a sphere using the algorithm presented in Some Algorithms for Polygons on a Sphere by Chamberlain and Duquette (2007)*

- *GeodesicArea: Calculate the geodesic area and perimeter of a geometry on an ellipsoid using the algorithm presented in Algorithms for geodesics by Charles Karney (2013)*

- *Distance*

- *EuclideanDistance: Calculate the minimum euclidean distance between geometries*

- *GeodesicDistance: Calculate the minimum geodesic distance between geometries using the algorithm presented in Algorithms for geodesics by Charles Karney (2013)*

- *...and so on for many more algorithms...*

This might make you wonder: if there are so many algorithms to choose from, which ones did SurrealDB use for its `geo::area()` and `geo::distance()` formulas? We can find out by doing a search for `geo::` inside the source code. That brings us to a page with the following code, which shows which algorithms are used: Haversine for bearing, and Chamberlain Dequette for area.

```surql
use geo::algorithm::bearing::HaversineBearing;
use geo::algorithm::haversine_distance::HaversineDistance;
use geo::algorithm::chamberlain_duquette_area::ChamberlainDuquetteArea;
pub fn area((arg,): (Value,)) -> Result<Value, Error> {
  match arg {
    Value::Geometry(v) => match v {
      Geometry::Point(v) => Ok(v.chamberlain_duquette_unsigned_area().into()),
      Geometry::Line(v) => Ok(v.chamberlain_duquette_unsigned_area().into()),
      Geometry::Polygon(v) => Ok(v.chamberlain_duquette_unsigned_area().into()),
      // ... and so on...
    },
    _ => Ok(Value::None),
  }
}
pub fn bearing(points: (Value, Value)) -> Result<Value, Error> {
  Ok(match points {
    (Value::Geometry(Geometry::Point(v)), Value::Geometry(Geometry::Point(w))) => {
      v.haversine_bearing(w).into()
    }
    _ => Value::None,
  })
}
pub fn centroid((arg,): (Value,)) -> Result<Value, Error> {
  let centroid = match arg {
    Value::Geometry(v) => match v {
      Geometry::Point(v) => Some(v.centroid()),
      Geometry::Line(v) => v.centroid(),
      Geometry::Polygon(v) => v.centroid(),
      Geometry::MultiPoint(v) => v.centroid(),
      // ... and so on ...
    },
    _ => None,
  };
  Ok(centroid.map(Into::into).unwrap_or(Value::None))
}
pub fn distance(points: (Value, Value)) -> Result<Value, Error> {
  Ok(match points {
    (Value::Geometry(Geometry::Point(v)), Value::Geometry(Geometry::Point(w))) => {
      v.haversine_distance(&w).into()
    }
    _ => Value::None,
  })
}
```

The [fuzzy-matcher](https://crates.io/crates/fuzzy-matcher) crate also goes into quite a bit of detail on how its algorithm works. As Rust code only uses underscores for path names, a search for `fuzzy_matcher::` will show that a certain `fuzzy_matcher::skim::SkimMatcherV2` is being used. The crates.io page for fuzzy-matcher leads us to [this paper](https://www.cs.cmu.edu/~ckingsf/bioinfo-lectures/gaps.pdf) with all the details on the algorithm - a great read if that is your kind of reading material.

The above hints should be enough to get you started, even if you aren't a Rust developer (or a developer at all). Feel free to [drop by SurrealDB's Discord](https://discord.gg/surrealdb) - `#rust` is a good place to start for this chapter, and `#help` or `#general` work for anything else - or [any other part of the SurrealDB community](https://github.com/surrealdb/surrealdb) if you have any questions.

It looks like this chapter has an epilogue. Let's see what's going on!

## The ancient calendar returns

> *Another message has arrived from Landevin, who is back in Europe again. The message had exciting news. Apparently, the comet in the sky this summer was so famous in the ancient world that it even has a name: Halley's Comet. It always showed up every 77 years or so.*

> *The European astronomers were able to match the information from your database with their observations of the comet from the past. A few calculations then led to today's date according to the old calendar: the 1st of December, 2749!*

> *What a thrill it was to suddenly have a connection with the ancient world! The rest of the world seems to feel the same way too. For the first time in a while, your communication with the world governments over the following weeks was a happy one. They were fascinated by your idea to celebrate the new year together in the old style, and quickly agreed to make preparations. For the first time in many centuries, the world will be counting down the seconds to bring in the new year together.*

> *2750 is going to be a good year, you can feel it!*

![A new year's card celebrating the incoming year 2750.](/assets/static/part-17-happy-2750.CKuB02kD.avif)

How very futuristic!

To match the celebratory atmosphere, we are going to have some fun starting from the next chapter. Now that we have learned most of the ins and outs of SurrealDB, we are going to put our knowledge to use by building something that will allow us to practice what we already know.

Practice time

### 1. The `is_a` relation below is similar to the one in this chapter but uses objects instead of booleans. Will the same queries work?

Here is the data...

```surql
CREATE bank:first_bank_of_toria, person:aeon, person:customer, person:employee SET name = id.id();
RELATE person:aeon->is_a->bank:first_bank_of_toria SET
  customer = {
        money: 100000
    },
  director = {
        hours_worked: "Whenever"
    };
RELATE person:customer->is_a->bank:first_bank_of_toria SET
  customer = {
        money: 100
    };
RELATE person:employee->is_a->bank:first_bank_of_toria SET
  employee = {
        hours_worked: "9 to 5"
    };
  customer = {
        money: 300
    };
```

...and the relation queries. Will it work?

```surql
SELECT *,
  <-is_a[WHERE employee].in.* AS people.employees,
  <-is_a[WHERE customer].in.* AS people.customers,
  <-is_a[WHERE director].in.* AS people.directors
FROM bank:first_bank_of_toria;
SELECT *,
    ->is_a[WHERE employee].out AS works_at,
    ->is_a[WHERE director].out AS directs,
    ->is_a[WHERE customer].out AS banks_with
FROM person;
```

Answer

Yes, it will work. This is because statements and clauses like `IF` and `WHERE` compare for truthiness of a value as opposed to a straight boolean. Thus, `[WHERE employee]` simply means "where the `employee` field is truthy".

### 2. Browsing some source code, you come across these two tests. Does it remind you of a concept we learned earlier in the book?

```surql
  #[test]
  fn simple() {
    let sql = "(-0.118092, 51.509865)";
    let out = Value::parse(sql);
    assert_eq!("(-0.118092, 51.509865)", format!("{}", out));
  }
  #[test]
  fn point() {
    let sql = r#"{
      type: 'Point',
      coordinates: [-0.118092, 51.509865]
    }"#;
    let out = Value::parse(sql);
    assert_eq!("(-0.118092, 51.509865)", format!("{}", out));
  }
```

Answer

Back in Chapter 10 we saw once that passing in a `Point` using the GeoJSON spec would return a point represented as two numbers, as opposed to the original object. The example we gave to show this is as follows:

```surql
RETURN [(-0.1119, 51.5091),
{
    "type": "Point",
    "coordinates": [
        -0.1119,
    51.5091
    ]
}];
```

**Response**

```surql
[
  (-0.1119, 51.5091),
  (-0.1119, 51.5091)
]
```

### 3. What happens when you use `!` and `!!` on a value like `""` or `0`?

Answer

Both operators work on truthiness (whether a value is effectively empty), not only on booleans.

- `!""` and `!0` return `true` because the empty string and zero are non-truthy.

- `!!""` returns `false` - it means “is this value present / non-empty?”

The `!!` is useful when you want a quick “has a real value” check inside `WHERE` clauses or functions.

### 4. In a graph query, what does `[WHERE employee]` on a relation mean when `employee` is an object field, not a boolean?

Answer

It filters to edges where the `employee` field is truthy. An object like `{ hours_worked: "9 to 5" }` counts as true, so the same queries from this chapter still work when roles are stored as objects instead of `true` / `false`.
