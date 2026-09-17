# 13: Viewing the database as a whole

Now that we have some data in the database, let's see what it looks like as a whole. The [`INFO FOR DB`](/docs/reference/query-language/statements/info) command will do this.

```surql
INFO FOR DB;
```

The output shows three schemaless tables. These are automatically created every time you use a `CREATE` statement for a table that doesn't exist yet. If you want to disable this behaviour, you can start SurrealDB in [strict mode](/docs/reference/cli/surrealdb-cli/commands/start#strict-mode). In strict mode, you need to manually [define](/docs/reference/query-language/statements/define/overview) anything before you can use it.

All of the statements inside the `INFO FOR DB` output are followed by a `PERMISSIONS NONE` clause, meaning that they can't be accessed by [record users](/docs/reference/query-language/statements/define/access/record) - users that aren't core database users.

But inside the Sandbox we are logged in as [a root user](/docs/reference/query-language/statements/define/user#statement-syntax), so `PERMISSIONS NONE` doesn't affect us.

**Response**

```surql
{
  accesses: {},
  analyzers: {},
  configs: {},
  functions: {},
  models: {},
  params: {},
  tables: {
    place: 'DEFINE TABLE place TYPE ANY SCHEMALESS PERMISSIONS NONE',
    some_record: 'DEFINE TABLE some_record TYPE ANY SCHEMALESS PERMISSIONS NONE',
    town: 'DEFINE TABLE town TYPE ANY SCHEMALESS PERMISSIONS NONE'
  },
  users: {}
}
```

One of the tables is called `some_record`, which we created back on [page 6](/learn/tour/page-06) for a simple demonstration. While we deleted all of its records, the `DEFINE TABLE` statement to create it in the first place wasn't touched, leaving our database with a `DEFINE TABLE some_record` that we never used again.

Since we won't be needing it, let's remove it with a [`REMOVE`](/docs/reference/query-language/statements/remove) statement. Since the statement to create it was `DEFINE TABLE some_record...`, it can be removed with `REMOVE TABLE some_record`.

```surql
REMOVE TABLE some_record;
```

**Response**

```surql
NONE
```

The output is `NONE`, showing that the statement succeeded and returned nothing. If you try to run the same `REMOVE` statement again, you'll see an error instead.

**Response**

```surql
"The table 'some_record' does not exist"
```

The statements `REMOVE DATABASE` or `REMOVE NAMESPACE` or `REMOVE INDEX` often require removing quite a bit of underlying data. When you execute one of these statements it will return immediately, after which physical deletion of the actual data takes place in the background.
