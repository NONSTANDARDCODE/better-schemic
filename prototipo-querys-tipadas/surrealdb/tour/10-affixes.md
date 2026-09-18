# 10: Affixes

Another way to make a datetime is by using the `d` prefix. Affixes look similar to casts but are instructions to *parse* input as a certain type, rather than to *convert* into another type. Thanks to this, the queries below won't even run because the parser can already see that the last one won't work.

```surql
-- Works
<datetime>'1859-11-26';
-- Returns an error
<datetime>'EIGHTEEN FIFTY NINE, NOVEMBER TWENTY SIX';
-- Works
d'1859-11-26';
-- Query won't even run
d'EIGHTEEN FIFTY NINE, NOVEMBER TWENTY SIX';
```

**Response**

```surql
"There was a problem with the database: Parse error: Invalid datetime,
expected digit character found `E`
--> [8:3]
  |
8 | d'EIGHTEEN FIFTY NINE, NOVEMBER TWENTY SIX';
  |   ^ 
"
```

Another example where you would want to avoid a cast is when using the `decimal` type, a numeric type used for greater precision or extra large numbers. In all programming languages, a float with too many digits after the decimal point will become imprecise.

```surql
1000.0000000000001;
1000.00000000000001;
```

**Response**

```surql
-------- Query 1 --------
1000.0000000000001f
-------- Query 2 --------
1000f
```

But if you use a cast on such a number, the database will first create an imprecise float and *then* cast it into a decimal. So you don't want to use a cast either.

```surql
<decimal>1000.00000000000001;
```

**Response**

```surql
1000dec
```

Using the `dec` suffix solves the problem by telling the database to treat the input as a decimal instead of a float.

```surql
1000.00000000000001dec;
```

**Response**

```surql
1000.00000000000001dec
```
