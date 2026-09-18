# 16: Literal types and assertions

## Literal types

While `option` provides the flexibility to either have or not have a value, sometimes you'll need to have a type that has a number of possible values or forms. A literal type can be used in this case, which is made by separating all of its possibilities by a `|` bar. We can use a literal type for the `place_type` field, which will look like this.

```surql
DEFINE FIELD place_type
    ON place
    TYPE "building" | "tower" | "store" | "school" | "park" | "library";
```

You can declare a type inside a query too, such as inside a `LET` statement. This is especially useful when using parameters because it lets you validate types each step of the way.

In the example below, `LET $name` followed by a typo (`naame` instead of `name`) will still run, even though the value will be `NONE` because there is no field called `naame`. But if you declare it as a `string`, the database will catch the mistake and let you know that the type doesn't match.

```surql
LET $name = town:riverdale.naame;
LET $name: string = town:riverdale.naame;
```

**Response**

```surql
"'Tried to set `$name`, but couldn't coerce value: Expected `string` but found `NONE`"
```

A literal type can be used in a `LET` statement as well.

```surql
LET $type: "building" | "school" | "park" = place:surreal_library.place_type;
```

**Response**

```surql
"Tried to set `$type`, but couldn't coerce value: Expected `'building' | 'school' | 'park'` but found `'library'`"
```

A literal type can even include a combination of values and type names. The following literal can either be the string "Good", or an object with an `error_type` and `message` field, both of which also have their own possible values. If you are familiar with enums and tagged unions in other languages, you can think of this as the SurrealQL version of them.

```surql
LET $result: 
    "Good"
    | { error_type: "Bad gateway" | "Unauthorized", message: string } 
= { error_type: "Unauthorized", message: "Can't be accessed at this time" };
RETURN $result;
```

**Response**

```surql
{
  error_type: 'Unauthorized',
  message: "Can't be accessed at this time"
}
```

## Assertions

Inside a `DEFINE FIELD` statement, you can also add an `ASSERT` clause for the `$value` parameter, which is the value of the field. We've already defined the `place_type` field using a literal, but we could have used an `ASSERT` in this way to do the same thing.

```surql
DEFINE FIELD place_type
    ON place
    TYPE string
    ASSERT $value IN ["building", "tower", "store", "school", "park", "library"];
```

However, we can use an assertion on the `population` field! With the `OVERWRITE` clause we can rewrite the definition, this time asserting that a town's population can't be negative.

```surql
DEFINE FIELD OVERWRITE population ON town TYPE int ASSERT $value >= 0;
```

With this assertion in place, no towns can be created that have a negative number of people.

```surql
-- Riverdale, but everything is backwards including the name
CREATE town SET name = "eladreviR", population = -75000;
```

**Response**

```surql
'Found -75000 for field `population`, with record `town:m8doql9mfgs6m4gs2zln`,
but field must conform to: $value >= 0'
```
