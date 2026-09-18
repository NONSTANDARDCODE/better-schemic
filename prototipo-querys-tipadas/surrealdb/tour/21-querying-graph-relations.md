# 21: Querying graph relations

Querying a relation is usually done using the same arrow syntax used in the `RELATE` statement to create it.

Here is a query on a single `person` record which returns its `name` as well as the path `->works_at->place`. The graph query checks to see if the person is linked to the `works_at` table (the `in` field, because the arrow at `->works_at` is going in to `works_at`) and if there is a `place` at the other end (the `out` field, because the arrow at `works_at->place` goes out from `works_at` and looks for a `place` record at that point).

```surql
SELECT 
    name, 
    ->works_at->place
FROM person LIMIT 1;
```

**Response**

```surql
[
  {
    "->works_at": {
      "->place": [
        place:surreal_library
      ]
    },
    name: 'Lydia Wyndham'
  }
]
```

Since the `place` point in the query will look for `place` records, the `.{}` destructuring operator can be used to access the fields, such as `name` and `address`. We will also give it the alias `workplace` for readability, and remove the `LIMIT` to show all the `person` records.

```surql
SELECT 
    name, 
    ->works_at->place.{ 
    name, 
    address
  } AS workplace
FROM person;
```

**Response**

```surql
[
  {
    name: 'Sara Bellum',
    workplace: [
      {
        address: '2025 Statement Street, Riverdale',
        name: 'Surreal Library'
      }
    ]
  },
  {
    name: 'Lydia Wyndham',
    workplace: [
      {
        address: '2025 Statement Street, Riverdale',
        name: 'Surreal Library'
      }
    ]
  },
  {
    name: 'Samm Schwartz',
    workplace: [
      {
        address: '2025 Statement Street, Riverdale',
        name: 'Surreal Library'
      }
    ]
  }
]
```

You can also use a graph query directly on a record instead of using a `SELECT` statement.

```surql
-- Get Samm's record ID
LET $samm = SELECT id FROM ONLY person WHERE name = 'Samm Schwartz' LIMIT 1;
-- Then just query from the record ID, no SELECT
$samm->works_at->place.{ address, floors, name };
```

**Response**

```surql
[
  {
    address: '2025 Statement Street, Riverdale',
    floors: 8,
    name: 'Surreal Library'
  }
]
```

Turning the `->` arrow around to `<-` makes a graph query in the other direction. From the point of view of the `place` record, there is no `->works_at->person` path because it's not the `place` that works at the `person`, it's the `person` that works at the `place`. Turning the arrows around will accomplish this.

The relation is still visually easy to follow, because `place<-works_at<-person` still shows that `person` leads into `works_at` and then into `place`. The only difference is that `place` is being used as the starting point now.

```surql
place:surreal_library<-works_at<-person.name;
```

Output: the names of the people that work at the library.

**Response**

```surql
[
  'Samm Schwartz',
  'Sara Bellum',
  'Lydia Wyndham'
]
```
