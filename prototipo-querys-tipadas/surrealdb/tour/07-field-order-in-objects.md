# 7: Field order in objects

Now that all the `place` records that we used for testing are deleted, let's create the one library that we will use in this tour. This time it will have three fields besides an `id`: a `name`, an `address`, and the number of `floors`. To do this, we can use `SET` along with the names of these fields and a value for each.

```surql
CREATE place:surreal_library SET
    name = "Surreal Library",
    address = "2025 Statement Street, Riverdale",
    place_type = "library",
    floors = 8;
```

While the fields inside the `CREATE` statement weren't in alphabetical order, the output always will be.

```surql
[
  {
    address: '2025 Statement Street, Riverdale',
    floors: 8,
    id: library:76wabj5zw4g4qcuy9o3y,
    name: 'Surreal Library',
    place_type: 'library'
  }
]
```

This behaviour is because [anything can be compared and ordered in SurrealDB](/docs/reference/query-language/language-primitives/data-types/values#comparing-and-ordering-values). Even objects can be compared, because their fields are lined up alphabetically and compared in that order.

This next example returns `true` because the value `9` for `floors` (alphabetically the first field) in the first object is greater than 8 in the second.

```surql
{
  floors: 9,
  name: 'A Library'
} > {
  floors: 8,
  name: 'Surreal Library'
};
```

But if you change `name` to `a_name` it will now be compared before `floors`. And because "A Library" (which starts with A) is less than "Surreal Library" (which starts with S), the output is now `false`.

```surql
{
  floors: 9,
  a_name: 'A Library'
} > {
  floors: 8,
  a_name: 'Surreal Library'
};
```
