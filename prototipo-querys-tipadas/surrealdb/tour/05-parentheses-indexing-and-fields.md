# 5: Parentheses, indexing, and fields

The first item in an array is at index 0, so you can use `[0]` to grab it.

```surql
["first", "second", "third"][0];
```

**Response**

```surql
'first'
```

Since it's impossible to always know the last index number of an array, the last element uses its own character: `[$]`.

```surql
["first", "second", "third"][$];
```

**Response**

```surql
'third'
```

And since statements like `CREATE` return an array of results, you might want to pull out the result at a certain index too.

But if you just add `[0]` at the end of a CREATE statement it won't work, because the `[0]` in `place[0]` applies to `place` (which is just a table name), not to the result of `CREATE place`.

```surql
CREATE place[0];
```

**Response**

```surql
"Can not execute CREATE statement using value 'NONE'"
```

To fix it, surround the whole statement in parentheses first.

```surql
(CREATE place)[0];
```

Records have an object-like structure that holds keys (fields) and values. You can access a single field by using a dot and then the field name.

```surql
{
    name: "Surreal library",
    id: place:surreal_library
}.id;
```

**Response**

```surql
place:surreal_library
```

As above, you can surround a statement in parentheses and then choose a field to return.

Accessing a single field

```surql
(CREATE place).id;
```

The output is an array of IDs, because `.id` tells the database to go through the array and only gather the values of the `id` field.

**Response**

```surql
[
  place:exqlj50tybc6yb1wjrx3
]
```

If you want to access more than one field, you can give the output a [structure](/docs/reference/query-language/language-primitives/idioms#destructuring) by adding a `{}` after the dot and putting the field names inside there.

Accessing multiple fields

```surql
(CREATE place SET place_type = "library", num_books = 10000).{
  place_type,
  num_books
};
```

**Response**

```surql
[
  {
    num_books: 10000,
    place_type: 'library'
  }
]
```
