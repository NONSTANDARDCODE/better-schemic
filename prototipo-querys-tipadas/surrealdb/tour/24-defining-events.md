# 24: Defining events

One of the most convenient parts of SurrealDB is the ability to [define an event](/docs/reference/query-language/statements/define/event) whenever a record is created, updated, or deleted (or any combination of the three).

In the last chapter we created some books using this `CREATE` statement, but we haven't defined any fields yet.

```surql
LET $book = CREATE ONLY book SET
    author = $data.author,
    english_title = $data.english_title,
    language = $data.language,
    published = <datetime>$data.published,
    title = $data.title;
```

Three of those fields should always be present, so let's officially define them now.

```surql
DEFINE FIELD author   ON book TYPE string;
DEFINE FIELD language ON book TYPE string;
DEFINE FIELD title    ON book TYPE string;
```

An `english_title` should also be present, but we can use an event to fill it out or check to see if it has been entered. This is because:

- If the book is written in English, the `english_title` field should be the same as `title`. We don't want user error to result in `title` and `english_title` being different.

- If the book is written in another language, we should check to see if `english_title` has been filled out. If not, throw an error.

The `DEFINE EVENT` syntax looks like this.

```surql
DEFINE EVENT event_name ON table_name [ WHEN some_expression ] THEN {
   // Write what you want to happen here
};
```

It also gives access to the type of event (either "CREATE", "UPDATE", or "DELETE") through a parameter called `$event`, along with `$before` and `$after` for the record before and after the change was made.

To create our event, we will use the following:

- `WHEN $event = "CREATE"` to do this check when a book is first created,

- Check if `$after.language = 'en'`, and `UPDATE` the `english_title` field with `$after.title` if so,

- If `$after.language` is not equal to `'en'` and there is no `english_title` field filled in, then throw an error using the `THROW` keyword and a custom message.

```surql
DEFINE EVENT language_check ON book WHEN $event = "CREATE" THEN {
    IF $after.language = 'en' {
        UPDATE $after SET english_title = $after.title;
    } ELSE IF $after.language != 'en' AND $after.english_title IS NONE {
        THROW "Please enter an English title for " 
            + $after.title + 
            " written in "
            + $after.language;
    }
};
```

With this event defined, we can enter a book without an `english_title` field but the event will fill it in using the `title` field.

```surql
CREATE book SET title = "The Shadow Rising", author = "Robert Jordan", language = 'en';
SELECT * FROM book WHERE title = "The Shadow Rising";
```

Note that the first response is the output of the `CREATE` statement, which doesn't include `english_title`. It's at this point that the event jumps in and adds the field.

**Response**

```surql
-------- Query --------
[
  {
    author: 'Robert Jordan',
    id: book:w8e6dv2db255h27ezrip,
    language: 'en',
    title: 'The Shadow Rising'
  }
]
-------- Query--------
[
  {
    author: 'Robert Jordan',
    english_title: 'The Shadow Rising',
    id: book:w8e6dv2db255h27ezrip,
    language: 'en',
    title: 'The Shadow Rising'
  }
]
```

And if we try to enter this next French book, the query will fail because we forgot to fill out the `english_title`.

```surql
CREATE book SET
    title = "La Détresse et l'enchantement",
    author = "Gabrielle Roy",
    language = 'fr';
SELECT * FROM book WHERE title = "La Détresse et l'enchantement";
```

The output this time doesn't show the initial `CREATE` statement before the event, because statements in SurrealDB are [all run within their own transaction](/docs/reference/query-language/language-primitives/transactions), including their events. Since the `CREATE` statement led to an event which failed, the entire statement is rolled back and the book is never created.

**Response**

```surql
-------- Query --------
"An error occurred: Please enter an English title 
for La Détresse et l'enchantement written in fr"
-------- Query --------
[]
```
