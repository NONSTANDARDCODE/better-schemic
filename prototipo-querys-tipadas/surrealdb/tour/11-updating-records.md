# 11: Updating records

A library all on its own isn't all that interesting, so let's create the town that holds it.

```surql
CREATE town:riverdale SET name = "Riverdale";
```

**Response**

```surql
[
  {
    id: town:riverdale,
    name: 'Riverdale'
  }
]
```

If we want, we can select both the library and town inside a single statement.

```surql
SELECT * FROM place, town;
```

**Response**

```surql
[
  {
    address: '2025 Statement Street, Riverdale',
    floors: 8,
    id: place:surreal_library,
    name: 'Surreal Library',
    place_type: 'library'
  },
  {
    id: town:riverdale,
    name: 'Riverdale'
  }
]
```

However, while these two records have turned up in the same query, they aren't actually connected to each other. It would be nice to link the two so that we could always access the library inside queries on the town. To do this, we can update the `town` record to add a link to the library.

[`UPDATE`](/docs/reference/query-language/statements/update) is similar to `CREATE` in that it can be followed by `SET` to set values for the fields. And like a `SELECT` statement, an `UPDATE` for a table without a `WHERE` will update every record for the table. A `WHERE` clause isn't truly needed here because we only have one `town`, but let's add it to make it clear. Also, this will guarantee that only the town of "Riverdale" gets updated even if we add more `town` records later.

To practice, we will first update Riverdale to give it a population of 75000.

```surql
UPDATE town
  SET population = 75000
WHERE name = "Riverdale";
```

**Response**

```surql
[
  {
    id: town:riverdale,
    name: 'Riverdale',
    population: 75000
  }
]
```

Now that we know how to update records, we can update this `town` again in the next page with a link.
