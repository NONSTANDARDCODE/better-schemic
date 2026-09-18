# 23: Adding and improving data

The library needs some customers too, so we'll add them. We will use a query that is similar to one we used before: create some `person` records, and relate them to the library.

However, this time we will add three automatically generated fields to the `customer_of` table to help keep track of customer histories. They all use a clause called [`VALUE`](/docs/reference/query-language/statements/define/field#using-the-value-clause-to-set-a-fields-value), but in different ways.

The first statement is for when the account is created. Its value is `time::now()` (the time when the operation is performed), and it is followed by `READONLY` because it should never be changed.

```surql
DEFINE FIELD account_created ON TABLE customer_of VALUE time::now() READONLY;
```

The second is called `last_updated`. It also takes a value of `time::now()`. Anything with a `VALUE` clause will be calculated when a record is created or updated, but not when it is simply read.

```surql
DEFINE FIELD last_updated ON TABLE customer_of VALUE time::now();
```

The last field is called `customer_for`, which shows how long a person has been a customer. This time the field name will be followed by something called a `COMPUTED` field, which holds an expression that is never stored but calculated every time a field is read. In this case, `time::now() - account_created` will do the job.

```surql
DEFINE FIELD customer_for
  ON TABLE customer_of
  COMPUTED time::now() - account_created;
```

With these fields defined, we can start creating some customers. Once they are created, we will do a query on one of the `customer_of` tables, use a [`SLEEP`](/docs/reference/query-language/statements/sleep) statement to make the database sleep for one second, and then query the table again.

```surql
FOR $data IN [
  { age: 15, name: 'Archie Andrews'   },
  { age: 15, name: 'Veronica Lodge'   },
  { age: 15, name: 'Betty Cooper'     },
  { age: 15, name: 'Jughead Jones'    },
  { age: 15, name: 'Reggie Mantle'    },
  { age: 50, name: 'Hiram P. Lodge'   },
    { age: 55, name: 'Geraldine Grundy' },
  { age: 65, name: 'Waldo Weatherbee' }
] {
    LET $person = CREATE ONLY person SET
        name = $data.name,
        age = $data.age;
    RELATE $person->customer_of->place:surreal_library;
};
SELECT 
  out.name AS customer_of,
  account_created,
  customer_for,
  last_updated
FROM customer_of LIMIT 1;
SLEEP 1s;
SELECT 
  out.name AS customer_of,
  account_created,
  customer_for,
  last_updated
FROM customer_of LIMIT 1;
```

You can see that the `customer_for` field will always be a greater number every time you select it, as more time will have passed since the last query.

**Response**

```surql
-------- Query --------
[
  {
    account_created: d'2025-03-19T05:26:14.912Z',
    customer_for: 1ms,
    customer_of: 'Surreal Library',
    last_updated: d'2025-03-19T05:26:14.912Z'
  }
]
-------- Query --------
[
  {
    account_created: d'2025-03-19T05:26:14.912Z',
    customer_for: 1s3ms,
    customer_of: 'Surreal Library',
    last_updated: d'2025-03-19T05:26:14.912Z'
  }
]
```

The library also needs some books. To keep things short, our library will have just the eight most sold books of all time. The data for each one looks like this.

```surql
{
    author: 'Charles Dickens',
    english_title: 'A Tale of Two Cities',
    language: 'en',
    published: '1859-11-26',
    title: 'A Tale of Two Cities'
}
```

When inserting, we can cast the `published` field as a `datetime` instead of a simple `string`. This will make it possible to use [datetime functions](/docs/reference/query-language/functions/database-functions/time) and [duration functions](/docs/reference/query-language/functions/database-functions/duration), or operators like `-` or `+`.

Here are two examples of the convenience you get when using the `datetime` and `duration` types as opposed to simple strings.

```surql
-- Time since the traditional founding of Rome, 753 BC
d'2025-01-01' - d'-0753-01-01';
-- Same time in hours
duration::hours(d'2025-01-01' - d'-0753-01-01');
```

**Response**

```surql
-------- Query --------
2779y44w1d
-------- Query --------
24351456
```

For each of these books in the next `FOR` loop, we will do the following:

- Since the `author` field is a person's name, we'll use it to create a `person`. The output of the `CREATE` statement will go in a parameter called `$author`.

- Create the book, capturing the output in the parameter `$book`.

- Relate the author to the book with `$person->wrote->$book`, and the book to the library with `RELATE place:surreal_library->has->$book`.

```surql
FOR $data IN 
[
  {
    author: 'Charles Dickens',
    english_title: 'A Tale of Two Cities',
    language: 'en',
    published: "1859-11-26",
    title: 'A Tale of Two Cities'
  },
    {
        author: "Antoine de Saint-Exupéry",
        english_title: "The Little Prince",
        language: "fr",
        published: "1943-04-15",
        title: "Le Petit Prince"
    },
  {
    author: 'Paulo Coelho',
    english_title: 'The Alchemist',
    language: 'pt',
    published: "1988-03-01",
    title: 'O Alquimista'
  },
  {
    author: 'J.K. Rowling',
    english_title: "Harry Potter and the Philosopher's Stone",
    language: 'en',
    published: "1997-06-26",
    title: "Harry Potter and the Philosopher's Stone"
  },
  {
    author: 'Agatha Christie',
    english_title: 'And Then There Were None',
    language: 'en',
    published: "1939-11-06",
    title: 'And Then There Were None'
  },
  {
    author: 'Cao Xueqin',
    english_title: 'Dream of the Red Chamber',
    language: 'zh',
    published: "1791-03-01",
    title: '紅樓夢'
  },
  {
    author: 'J.R.R. Tolkien',
    english_title: 'The Hobbit',
    language: 'en',
    published: "1937-09-21",
    title: 'The Hobbit'
  },
  {
    author: 'Lewis Carroll',
    english_title: "Alice's Adventures in Wonderland",
    language: 'en',
    published: "1865-07-04",
    title: "Alice's Adventures in Wonderland"
  }
] {
    -- Create the author for each book, return just the object
    LET $author = CREATE ONLY person SET
        name = $data.author;
    -- Create the book, cast 'published' field from string to datetime
    LET $book = CREATE ONLY book SET
        author = $data.author,
        english_title = $data.english_title,
        language = $data.language,
        published = <datetime>$data.published,
        title = $data.title;
    -- Connect the author to the book
    RELATE $author->wrote->$book;
    -- Give the book to the library
    RELATE place:surreal_library->has->$book;
};
```

With the authors and books in the library, we can do more graph queries. Let's try two of them here.

Which books have been written by three sample authors in the database? The `->wrote->book.title` path will show this. We can add `WHERE ->wrote->book` too to make it only return people that wrote books.

```surql
SELECT 
  name AS author, 
  ->wrote->book.title AS books
FROM person
  WHERE ->wrote->book
  LIMIT 3;
```

**Response**

```surql
[
  {
    author: 'J.R.R. Tolkien',
    books: [
      'The Hobbit'
    ]
  },
  {
    author: 'Agatha Christie',
    books: [
      'And Then There Were None'
    ]
  },
  {
    author: 'Lewis Carroll',
    books: [
      "Alice's Adventures in Wonderland"
    ]
  }
]
```

What are the names of the places and the books that they have? The `->has.out.title` path will show this.

```surql
SELECT 
  name, 
  ->has.out.title AS books
FROM place;
```

**Response**

```surql
[
  {
    books: [
      'The Hobbit',
      'And Then There Were None',
      'A Tale of Two Cities',
      "Harry Potter and the Philosopher's Stone",
      'Le Petit Prince',
      "Alice's Adventures in Wonderland",
      '紅樓夢',
      'O Alquimista'
    ],
    name: 'Surreal Library'
  }
]
```
