# 9: Casting and aliases

SurrealDB has a lot of [data types](/docs/reference/query-language/language-primitives/data-types), with names in lowercase such as `bool`, `number`, `string`, and `array`. Most types can be quickly changed into another by using a [casting function](/docs/reference/query-language/language-primitives/casting). To cast into another type, put the target type inside `<>` angle brackets to the left.

```surql
SELECT 
    name, 
    address, 
    -- 'floors' is a number, output as a string instead
    <string> floors
FROM place;
```

One of the fields is called `"<string> floors"`, because by default a field with a value set by an operation will have the operation as its name.

**Response**

```surql
[
  {
    "<string> floors": '8',
    address: '2025 Statement Street, Riverdale',
    name: 'Surreal Library'
  }
]
```

If you find this field name ugly or want to rename it for another reason, you can use `AS` to give it a different name (give it an alias).

```surql
SELECT
    name,
    address,
    <string>floors AS floors
FROM place;
```

**Response**

```surql
[
  {
    address: '2025 Statement Street, Riverdale',
    floors: '8',
    name: 'Surreal Library'
  }
]
```

Casting will only work as long as the input is valid, mind you.

```surql
-- Works fine
<datetime>'1859-11-26';
-- Invalid input for datetime
<datetime>'EIGHTEEN FIFTY NINE, NOVEMBER TWENTY SIX';
-- A bool can only be 'true' or 'false'
<bool>"Hello there!";
```

**Outputs**

```surql
-------- Query 1 --------
d'1859-11-26T00:00:00Z'
-------- Query 2 --------
"Expected a datetime but cannot convert 'EIGHTEEN FIFTY NINE, NOVEMBER TWENTY SIX' into a datetime"
-------- Query 3 --------
"Expected a bool but cannot convert 'Hello there!' into a bool"
```

Casting also won't work for complex types because the database can't tell what you want to do. Take this object for example that you would like to turn into an array.

```surql
-- This cast won't work
<array>{
    address: '2025 Statement Street, Riverdale',
    floors: '8',
    name: 'Surreal Library'
};
```

You might want an array holding each key, or arrays holding each key and value, and so on. In this case, take a look at SurrealDB's [object functions](/docs/reference/query-language/functions/database-functions/object) to choose how to transform from one type into another. For example, you could use the `object::values()` function to just return the object's values.

```surql
-- Regular function syntax
object::values({
  address: '2025 Statement Street, Riverdale',
  floors: '8',
  name: 'Surreal Library'
});
-- Method syntax: same function, same result
{
  address: '2025 Statement Street, Riverdale',
  floors: '8',
  name: 'Surreal Library'
}.values();
```

**Array of the object's values**

```surql
[
  '2025 Statement Street, Riverdale',
  '8',
  'Surreal Library'
]
```

Or you could use [`object::from_entries()`](/docs/reference/query-language/functions/database-functions/object#objectfrom_entries) to do the opposite: constructing an object from arrays of arrays.

```surql
object::from_entries([
  [
    'address',
    '2025 Statement Street, Riverdale'
  ],
  [
    'floors',
    '8'
  ],
  [
    'name',
    'Surreal Library'
  ]
]);
```

**Response**

```surql
{
  address: '2025 Statement Street, Riverdale',
  floors: '8',
  name: 'Surreal Library'
}
```

The [`array::map()`](/docs/reference/query-language/functions/database-functions/array#arraymap) function is another great way to turn one type into another. After typing `.map()`, choose a parameter name inside `||` for each item, and then choose what to do with each item before passing it on.

This example of the function takes two strings and turns each one of them into an object with three fields. The output is an array of objects created by each string.

```surql
["Surreal Library", "Riverdale"].map(|$name| {
    name: $name,
    is_cool: true,
  name_is_long: $name.len() > 10
});
```

**Response**

```surql
[
  {
    is_cool: true,
    name: 'Surreal Library',
    name_is_long: true
  },
  {
    is_cool: true,
    name: 'Riverdale',
    name_is_long: false
  }
]
```
