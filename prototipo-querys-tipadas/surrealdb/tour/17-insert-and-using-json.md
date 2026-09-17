# 17: INSERT and using JSON

Our library is going to need some books. It will also have employees, customers, and the names of the authors of the books. We can use a single table called `person` here, because a `person` can be an employee, customer, and book author all at the same time.

As SurrealDB is a document database by default, it works well with large arrays of objects, whether in SurrealQL format or JSON. So if we had the following JSON data for the employees at the library, we could insert it directly into the database without first needing to convert fields like `"name"` into `name`.

```surql
[
    {
        "name": "Sara Bellum",
        "age": 30        
    },
    {
        "name": "Lydia Wyndham",
        "age": 25        
    },
    {
        "name": "Samm Schwartz",
        "age": 45        
    }
]
```

The most straightforward way to insert data like this into a table is by using [INSERT INTO](/docs/reference/query-language/statements/insert), followed by the table name.

```surql
INSERT INTO person [
    {
        "name": "Sara Bellum",
        "age": 30        
    },
    {
        "name": "Lydia Wyndham",
        "age": 25        
    },
    {
        "name": "Samm Schwartz",
        "age": 45        
    }
];
```

It has been automatically converted into SurrealQL, which is different but somewhat similar in appearance to JSON.

**Response**

```surql
[
  {
    age: 30,
    id: person:jbcyzmur1jalageanc1u,
    name: 'Sara Bellum'
  },
  {
    age: 25,
    id: person:qjvcx5sd1ee5mi1mpdiq,
    name: 'Lydia Wyndham'
  },
  {
    age: 45,
    id: person:uox9flf3m61wmqm0yybs,
    name: 'Samm Schwartz'
  }
]
```

Inside SurrealDB Studio (two buttons to the left of the button used to run your queries), you can choose to display output either as SurrealQL or JSON. Unless there is a reason to use JSON, SurrealQL is generally the better option because it is easier to see the type.

Take this query for example.

```surql
RETURN [
    time::now(),
    SELECT VALUE id FROM ONLY town LIMIT 1
];
```

If the display output is SurrealQL, you can always tell that this output holds a datetime and a record ID.

```surql
[
  d'2025-02-09T06:05:18.572Z',
  town:wmq63dk1qbgnbhjrnxhj
]
```

If the display output is JSON, you can eyeball the output and probably conclude that this is a datetime and a record ID, but they might both be strings instead!

```surql
[
  "2025-02-09T06:05:40.791Z",
  "town:wmq63dk1qbgnbhjrnxhj"
]
```
