# 20: Creating graph edges

To create a graph relation, we can use the [`RELATE`](/docs/reference/query-language/statements/relate) statement. The syntax for this statement is `RELATE record->graph_table_name->record`, leading to quite readable syntax since graph tables are usually a verb or similar word ("place employs person", "person likes book", and so on).

Here is what some typical `RELATE` statements look like.

```surql
-- Create writer->wrote->blog path
RELATE writer:one->wrote->blog:one;
-- Create reader->likes->magazine path
RELATE reader:one->likes->magazine:one
    SET stars_out_of_ten = 7.5; -- and give it a field too if we want
```

**Response**

```surql
-------- Query --------
[
  {
    id: wrote:7l04nq3umzufbemaldlz,
    in: writer:one,
    out: blog:one
  }
]
-------- Query --------
[
  {
    id: likes:jd17lotl4nnyf06jl2ng,
    in: reader:one,
    out: magazine:one,
    stars_out_of_ten: 7.5f
  }
]
```

Using this syntax, we can now create the employees inside a `FOR` loop and link them to the library at the same time.

Inside the query below is an array of objects that contain the employee data. Inside each loop, we can create a single `person` record using the `ONLY` keyword and assign the output to a parameter called `$created`. This parameter can then be used in the statement `RELATE $created->works_at->place:surreal_library`.

```surql
FOR $person IN [
  {
    age: 30,
    name: 'Sara Bellum'
  },
  {
    age: 25,
    name: 'Lydia Wyndham'
  },
  { 
    age: 45,
    name: 'Samm Schwartz'
  }
] {
    LET $created = CREATE ONLY person SET
        age = $person.age,
        name = $person.name;
    RELATE $created->works_at->place:surreal_library;
};
```

Now that the relations have been created, we can look at the `works_at` table to see what is inside. Querying in this way is no different from any other table.

```surql
SELECT * FROM works_at;
```

Each `works_at` record has its own random ID, has a `person` at the `in` field (the initiator of the relation), and a `place` at the `out` field (the target of the relation).

**Response**

```surql
[
  {
    id: works_at:3o8n3jmqx1uok41rjxq7,
    in: person:g94fc1nqsraaatplddyh,
    out: place:surreal_library
  },
  {
    id: works_at:f3ghd88elmvs1jwfhpoc,
    in: person:qpk3htqruhvd469pox0r,
    out: place:surreal_library
  },
  {
    id: works_at:j2yf2jdnmponak0v3q0q,
    in: person:6kittp2n5lwpjzgu29jt,
    out: place:surreal_library
  }
]
```

You can always query graph edges in this way if you want. For example, this query shows all the details for all the people at the `in` part of `works_at`, which in this case shows our `person` records.

```surql
SELECT in.* FROM works_at;
```

**Response**

```surql
[
  {
    in: {
      age: 45,
      id: person:f0z8cabmok8m9xn00lfu,
      name: 'Samm Schwartz'
    }
  },
  {
    in: {
      age: 30,
      id: person:zfdzeawmuqh2mm498edj,
      name: 'Sara Bellum'
    }
  },
  {
    in: {
      age: 25,
      id: person:ocp2l14l4nbgo60mnhgt,
      name: 'Lydia Wyndham'
    }
  }
]
```

However, the `->` and `<-` arrows used to create relations are also used to quickly move from one path to the next, and it is this syntax that is usually used when querying them. We'll give this syntax a try on the next page.
