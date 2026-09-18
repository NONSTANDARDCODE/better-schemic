# 12: Linking records

It's time to update the town of Riverdale again, this time with a link to the library. A [record link](/docs/reference/query-language/language-primitives/record-links) is quick to make in SurrealDB: if a field contains the record ID of one or more other records, that's a link! For our existing `town:riverdale` record, a simple `UPDATE` statement is all that is needed. Don't forget to put the library inside an array, because the town may have more libraries to add later.

```surql
UPDATE town:riverdale SET libraries = [place:surreal_library];
```

**Response**

```surql
[
  {
    id: town:riverdale,
    libraries: [
      place:surreal_library
    ],
    name: 'Riverdale',
    population: 75000
  }
]
```

If we had used a random ID instead of `place:surreal_library`, we would have first used `SELECT VALUE id` to get the record ID of the existing town and library, followed by a `WHERE` clause to filter. Let's practice this method too.

```surql
SELECT VALUE id FROM place WHERE "Riverdale" IN address;
```

**Response**

```surql
[ place:surreal_library ]
```

When working with random IDs like this, using [`LET`](/docs/reference/query-language/statements/let) to create a parameter is a great way to make the code readable. To set a parameter, use the `LET` keyword followed by `$` and the name that you want to give it.

Setting a parameter also makes it available for reuse, which can be convenient.

Connect library to town and use it again

```surql
-- Easy to read: this will be IDs of towns with the name Riverdale
LET $riverdale = SELECT VALUE id FROM town WHERE name = "Riverdale";
-- IDs of libraries with the name Riverdale in the address
LET $libraries = SELECT VALUE id FROM place WHERE "Riverdale" IN address;
-- Then update one with the other
UPDATE $riverdale SET libraries = $libraries;
-- Parameter is still around for reuse
-- If we had any cats we could link them to the libraries too
UPDATE cat SET libraries = $libraries;
```

By using either of these two ways, the library is now linked to the town! If we select from the `town` table, we can now see the library that we linked.

```surql
SELECT * FROM town;
```

**Response**

```surql
[
  {
    id: town:riverdale,
    libraries: [
      place:surreal_library
    ],
    name: 'Riverdale',
    population: 75000
  }
]
```

That output is a bit boring though, as the `libraries` only shows the record ID for the library.

To make the output more informative, we can add `.name` to `libraries` to directly access the place's name.

```surql
SELECT *, libraries.name FROM town;
```

**Response**

```surql
[
  {
    id: town:riverdale,
    libraries: [
      {
        name: [
          'Surreal Library'
        ]
      }
    ],
    name: 'Riverdale',
    population: 75000
  }
]
```

Or we can use `.{}` to select some fields from the linked libraries, such as `name` and `floors`.

```surql
SELECT 
    *, 
    libraries.{ name, floors }
FROM town;
```

**Response**

```surql
[
  {
    id: town:riverdale,
    libraries: [
      {
        floors: 8,
        name: 'Surreal Library'
      }
    ],
    name: 'Riverdale',
    population: 75000
  }
]
```

A quick way to display all the fields of a linked record is by adding the `FETCH` keyword to the end.

```surql
SELECT * FROM town FETCH libraries;
```

**Response**

```surql
[
  {
    id: town:riverdale,
    libraries: [
      {
        address: '2025 Statement Street, Riverdale',
        floors: 8,
        id: place:surreal_library,
        name: 'Surreal Library',
        place_type: 'library'
      }
    ],
    name: 'Riverdale',
    population: 75000
  }
]
```
