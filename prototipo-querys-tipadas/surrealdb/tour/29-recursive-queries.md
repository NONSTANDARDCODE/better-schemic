# 29: Recursive queries

After all the setup we did in the last page, let's do a very basic recursive query starting at the building called Event Junction, located at the top left part of the map. Where can we go from here? Here are some of the ways to follow the `connected_to` path from here.

```surql
place:event_junction.connected_to;
place:event_junction.connected_to.connected_to;
place:event_junction.{2}.connected_to;
```

While the first query simply shows the two places that are connected to Event Junction, the second and third are slightly different.

- The second query is two arrays showing the possible places you could be if you had picked Index Avenue, or Rust Row, and gone on to the next path.

- The third query is a single array showing the possible places you could be after two steps away from Event Junction.

**Response**

```surql
-------- Query --------
[
  street:index_avenue,
  street:rust_row
]
-------- Query 2 --------
[
  [
    place:event_junction,
    place:surreal_square,
    place:surrealdb_university,
    street:bowler_hat_alley,
    street:record_link_way,
    street:rust_row,
    street:statement_street
  ],
  [
    place:idiom_tower,
    street:transaction_trail,
    street:bowler_hat_alley,
    street:index_avenue,
    street:schema_boulevard
  ]
]
-------- Query --------
[
  place:event_junction,
  place:surreal_square,
  place:surrealdb_university,
  street:bowler_hat_alley,
  street:record_link_way,
  street:rust_row,
  street:statement_street,
  place:idiom_tower,
  street:transaction_trail,
  street:bowler_hat_alley,
  street:index_avenue,
  street:schema_boulevard
]
```

The `{2}` in the third query is part of SurrealDB's recursive syntax. You can replace this with a different number, or a range. For example, writing `{..6}` tells the database to try up to a depth of 6.

There are also three keywords that you can add after this number or range, which tells the database to use a certain algorithm. They are:

- `path`, to show all the paths walked.

- `collect`, to collect all the unique records walked along the path.

- `shortest+some_record_id`, to show the shortest path to get to a certain record.

```surql
place:idiom_tower.{3+path}.connected_to;
```

The output is really long, so here are just the first two. It shows that you could:

- Go to Bowler Hat Alley, then Index Avenue, then Event Junction.

- Go to Bowler Hat Alley, then Index Avenue, then Surreal Square.

And so on.

**Response**

```surql
[
  [
    street:bowler_hat_alley,
    street:index_avenue,
    place:event_junction
  ],
  [
    street:bowler_hat_alley,
    street:index_avenue,
    place:surreal_square
  ]
]
```

The output for `collect` is a lot shorter: just a single array showing all the places you could visit within 3 steps.

```surql
place:idiom_tower.{3+collect}.connected_to;
```

```surql
[
  street:bowler_hat_alley,
  street:rust_row,
  street:schema_boulevard,
  street:index_avenue,
  place:idiom_tower,
  street:transaction_trail,
  place:access_court,
  street:recursive_crossing,
  place:event_junction,
  place:surreal_square,
  place:surrealdb_university,
  street:record_link_way,
  street:statement_street
]
```

With `shortest`, you will want to use a range instead of a set number. Let's see if we can find the shortest path from Idiom Tower to Push to Main Street within six steps.

```surql
place:idiom_tower.{..6+shortest=street:push_to_main_street}.connected_to;
```

The output shows that it can be done in four steps.

```surql
[
  street:bowler_hat_alley,
  street:index_avenue,
  street:record_link_way,
  street:push_to_main_street
]
```

And for all of these algorithms, you can add `+inclusive` if you want to include the original record.

```surql
place:idiom_tower.{..+shortest=street:push_to_main_street+inclusive}.connected_to;
```

```surql
[
  place:idiom_tower,
  street:bowler_hat_alley,
  street:index_avenue,
  street:record_link_way,
  street:push_to_main_street
]
```

Here we used `..` for an open range, because we don't know what depth the query will go down to. Instead, the algorithm will return as soon as it finds the shortest path.
