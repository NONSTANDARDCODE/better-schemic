# 15: Viewing the schema

Another advantage to having a schema is that the [Designer view](/docs/surrealist/concepts/designing-the-database-schema) inside SurrealDB Studio can use it to show a graphical overview of the types used in the database.

Without a schema, it isn't able to show much of anything. At the moment, all that it knows is that the database has two tables. But it has no idea whether `name` will always be a string, or whether `libraries` will always be an array that holds `place` records.

![A database schema containing two table names, place and town, and nothing else](/assets/static/schema1.BoEH1u2Z.avif)

The whole table doesn't need to be made `SCHEMAFULL` though. Instead, `DEFINE FIELD` can be used to define just one field at a time. This lets the table stay flexible for the most part, except for certain fields that we want to behave in a certain way.

Here is the [`DEFINE FIELD`](/docs/reference/query-language/statements/define/field) statement we used for practice on the last page.

```surql
DEFINE FIELD population ON schemafull_town TYPE number;
```

Following this format, we can define five fields to ensure that the fields for the `place` and `town` records can only be of a certain type.

```surql
-- Statements for the 'place' table
DEFINE FIELD address ON place TYPE string;
DEFINE FIELD name ON place TYPE string;
-- Statements for the 'town' table
DEFINE FIELD name ON town TYPE string;
DEFINE FIELD population ON town TYPE int;
DEFINE FIELD libraries ON town TYPE option<array<record<place>>>;
INFO FOR TABLE place;
INFO FOR TABLE town;
```

The `INFO FOR TABLE` statements are no longer empty, showing the definitions for each field.

**Response**

```surql
-------- Query --------
{
  events: {},
  fields: {
    address: 'DEFINE FIELD address ON place TYPE string PERMISSIONS FULL',
    name: 'DEFINE FIELD name ON place TYPE string PERMISSIONS FULL'
  },
  indexes: {},
  lives: {},
  tables: {}
}
-------- Query --------
{
  events: {},
  fields: {
    libraries: 'DEFINE FIELD libraries ON town TYPE option<array<record<place>>> PERMISSIONS FULL',
    "libraries.*": 'DEFINE FIELD libraries.* ON town TYPE record<place> PERMISSIONS FULL',
    name: 'DEFINE FIELD name ON town TYPE string PERMISSIONS FULL',
    population: 'DEFINE FIELD population ON town TYPE int PERMISSIONS FULL'
  },
  indexes: {},
  lives: {},
  tables: {}
}
```

The type of the last `DEFINE FIELD` statement above is a bit long: `option<array<record<place>>>`. That is because:

- Records are always of type `record<record_name>`, so places are `record<place>` and towns are `record<town>`.

- The `libraries` field should be able to hold more than one record, which gives us `array<record<place>>`.

- Not all towns have libraries, so we don't want to return an error if a `town` doesn't have this field. By wrapping it in an `option`, the `libraries` field doesn't need to be set in order to create a `town`.

Once these statements are executed, SurrealDB Studio will be able to make a much more informative graphical schema for us.

![A database schema containing the same town and place tables, but with their fields now indicated along with a record link between the two](/assets/static/schema2.BPjoHVE2.avif)
