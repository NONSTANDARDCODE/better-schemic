# Define fields, constraints and assertions

Now that we've defined our tables, it's time to also define our fields.

In this lesson, we'll cover how to:

- Define fields and their various data types

- Add field constraints and assertions

- Add permissions to field definitions

## Defining fields

The way fields are defined is similar to how we define tables.

```surql
DEFINE FIELD product_name ON TABLE order;
```

We use the `DEFINE FIELD` statement to, at a minimum, specify the field name and which table it belongs to, but usually also the `TYPE` as well. If the `TYPE` is not specified, it will default to `TYPE any`, which allows it to be set to any value.

The important thing to note is that the `DEFINE FIELD` statement can be used independently from the `DEFINE TABLE` statement, which is why we must always specify which table it belongs to using the `ON TABLE` clause.

## Data types

```surql
DEFINE FIELD product_name
    ON TABLE order
    TYPE string;
DEFINE FIELD quantity
    ON TABLE order
    TYPE number;
```

Defining simple data types is very straightforward, we just use the `TYPE` clause and the name of the data type, such as a string or number.

SurrealDB supports various datatypes, all of which you can find listed in our [documentation](/docs/reference/query-language/language-primitives/data-types).

Complex data types, as the name suggests, are not as straightforward, let's therefore spend some time looking at various examples. In particular nested objects and arrays.

### Objects

```surql
DEFINE FIELD time
    ON TABLE product
    TYPE object;
DEFINE FIELD time.created_at
    ON TABLE product
    TYPE datetime;
DEFINE FIELD time.updated_at
    ON TABLE product
    TYPE datetime;
```

Starting with objects, let's take the example of a field called `time` which is an object containing the `created_at` and `updated_at` fields.

- First, we define the `time` field as `TYPE object`

- Then we use the dot notation to define the fields inside the object separately.

In this case, we define both `time.created_at` and `time.updated_at` as a `TYPE datetime`.

Regardless of how nested the object is, we just use the dot notation to define each nested field, one at a time.

### Arrays and an arrays of objects

To define the contents of an array of strings there are two options:

- Using `TYPE array` with the string data type in angle brackets

- Using just `TYPE array` for the `sizes` field, then defining the contents using `.*`

```surql
DEFINE FIELD sizes
    ON TABLE product
    TYPE array<string>;
DEFINE FIELD IF NOT EXISTS sizes
    ON TABLE product
    TYPE array;
DEFINE FIELD IF NOT EXISTS sizes.*
    ON TABLE product
    TYPE string;
```

When defining arrays of objects such as this `addresses` array on the `address_history` table, you can use one of two approaches:

- Since `addresses.*` means all the address objects, use the dot notation again to define each nested field, such as `addresses.*.address_line_1`.

- Insert the field and type names directly into object notation. This is less wordy so will be the approach we will use.

```surql
DEFINE FIELD addresses
    ON TABLE address_history
    TYPE array<{
        address_line_1: string,
        address_line_2: option<string>,
        city: string,
        coordinates: geometry<point>,
        country: string,
        post_code: string
    }>;
-- The first approach:
-- DEFINE FIELD addresses.*.address_line_1
--     ON TABLE address_history
--     TYPE string;
-- DEFINE FIELD addresses.*.address_line_2
--     ON TABLE address_history
--     TYPE option<string>;
-- DEFINE FIELD addresses.*.city
--     ON TABLE address_history
--     TYPE string;
-- DEFINE FIELD addresses.*.coordinates
--     ON TABLE address_history
--     TYPE geometry<point>;
-- DEFINE FIELD addresses.*.country
--     ON TABLE address_history
--     TYPE string;
-- DEFINE FIELD addresses.*.post_code
--     ON TABLE address_history
--     TYPE string;
```

### Cheat code - flexible type

There is however an easy cheat code for nested objects and arrays when you do not want to apply a strict schema on every field.

```surql
DEFINE TABLE lesson SCHEMAFULL;
DEFINE FIELD summary
    ON TABLE lesson
    TYPE object FLEXIBLE;
```

The `FLEXIBLE` clause allows us to have schemaless fields on schemafull tables. This is especially useful for fields containing nested objects such as `shipping_address`, where the address structure can be very different based on the country we are shipping to.

```surql
DEFINE FIELD addresses
    ON TABLE address_history
    TYPE array<object> FLEXIBLE;
```

The field type is still `array<object>`. `FLEXIBLE` applies to each object in the array, so you can simplify `addresses` without defining every nested path.

### Record and option type

We can also define record IDs, using `TYPE record` with the table name of one or more records in angle brackets, such as the `TYPE record<seller>` field on the `product` table.

```surql
DEFINE FIELD seller 
    ON TABLE product 
    TYPE record<seller>;
```

Finally, we can use the option type to allow a field to either be empty or have the specified data type. As an example, using `TYPE option<datetime>` on the `time.shipped_at` field will allow it to be empty until the order is shipped.

## Constraints and assertions

```surql
DEFINE FIELD email
    ON TABLE person
    TYPE string
    ASSERT string::is_email($value);
DEFINE FIELD rating
    ON TABLE review
    TYPE number
    ASSERT $value > 0 AND $value < 6;
```

We can take our field definitions even further by using assertions. The `ASSERT` clause can be used to ensure that our data remains consistent.

For example:

- We can use assertions to ensure that the `email` field on our `person` table is always a valid email address.

- We can also ensure that the `rating` field on our `review` table is always a number greater than 0 and less than 6.

To do this we use the `$value` parameter as a placeholder for the field value. Assertions can be simple, but also contain complex logic.

### Default field values

The `DEFINE FIELD` statement has two clauses for setting a default value for our fields, `DEFAULT` and `VALUE`.

```surql
DEFINE FIELD time.created_at
    ON TABLE person
    TYPE datetime
    DEFAULT time::now();
DEFINE FIELD time.updated_at
    ON TABLE person
    TYPE datetime
    VALUE time::now();
```

The most practical way to explain the difference between them is:

- `DEFAULT` is better used for fields like `time.created_at` as the `DEFAULT time::now()` will be static once used for the first time.

- `VALUE` is better used for fields like `time.updated_at` because `VALUE time::now()` will run every time the record is updated.

In this way, we never again need to remember to use `time.created_at` or `time.updated_at` in our queries, as it will be created and updated for us when we insert a record into the table.

```surql
CREATE person:01FS8RCP2G9XPVJF9W0BFQFFRJ SET name = "Kevin";
SLEEP 2s;
UPDATE person:01FS8RCP2G9XPVJF9W0BFQFFRJ SET name = "Kevin Jackson";
```

Let's try by creating a new person, then using the `SLEEP` statement to wait for 2 seconds and then updating the person, so we can see the 2-second time difference in the `time.updated_at` field.

You can also use custom functions as default fields, such as the increment example we covered in our lesson on record IDs.

```surql
DEFINE FIELD serial_id
    ON TABLE person
    TYPE number
    VALUE fn::increment("person");
```

## Field permissions

Field permissions follow the same syntax as table permissions.

As an example, we can allow users to only update the shipping address on the order table if the order hasn't shipped yet.

```surql
DEFINE FIELD time.shipped_at
    ON TABLE order
    TYPE option<datetime>
    PERMISSIONS
      FOR select WHERE in.email = $auth.email,
      FOR create NONE,
      FOR update WHERE in.email = $auth.email AND time.shipped_at is NONE;
```

## Summary

There's a lot that the `DEFINE FIELD` statement can do so let's just summarise here.

The `DEFINE FIELD` statement allows us to define:

- Fields independently from the `DEFINE TABLE` statement

- Data types, such as strings, arrays and objects. Including the flexible type, which allows us to have schemaless fields on schemafull tables.

- Constraints and assertions, such as using a function for email validation.

- Default values, such as using the `time::now()` function to automatically create and update the `time.created_at` and `time.updated_at` fields.

- Field level `PERMISSIONS`, which can be done independently for each CRUD operation or all in one group.
