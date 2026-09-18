# Authentication

There are multiple forms of authentication built into SurrealDB, supporting different use cases.

In this lesson, we'll cover:

- System user authentication

- Record user authentication

- Sessions and expiration

- Query safety

## System users

System users are users defined directly on SurrealDB by using a [DEFINE USER](/docs/reference/query-language/statements/define/user) statement along with the `OWNER` role.

System users are assigned a level (root, namespace or database) to set the extent of this role in the system. These users have access to, and can create users in, their own space.

For a root user that means all namespaces and databases, for a namespace user that means one namespace and every database in it, and to round it out a database user gets to do this inside a single database.

In this first example we're creating a user for each of the levels, root, namespace and database with a “very secure password” and assigning the `OWNER` role.

```surql
DEFINE USER admin ON ROOT PASSWORD 'VerySecurePassword!' ROLES OWNER;
DEFINE USER john ON NAMESPACE PASSWORD 'VerySecurePassword!' ROLES OWNER;
DEFINE USER jane ON DATABASE PASSWORD 'VerySecurePassword!' ROLES OWNER;
```

Note that the `PASSWORD` clause turns into a `PASSHASH` clause in the actual definition, so the actual password isn't stored anywhere. This next example shows how to manually assign an `argon2` passhash that we then use in our user definition along with assigning the editor role.

```surql
RETURN crypto::argon2::generate('VerySecurePassword!');
DEFINE USER gordon_freeman ON DATABASE
PASSHASH '$argon2id$v=19$m=19456,t=2,p=1$0kz5uZcfFg/VPHoDEGYgbQ$8HBIZXSOYzZ2qickKAhxwenvILoiWuockJvB8Ma4Stg'
ROLES EDITOR;
```

If you are required to store passwords for your users, don't rely on table or field permissions to keep them private. In the event that your application or database is compromised, these passwords would become known by the attacker.

That's why [password hashing functions](/docs/reference/query-language/functions/database-functions/crypto) provided by SurrealDB are used instead. These functions ensure that irreversible cryptographic salted hashes are stored instead of the original passwords, so that the passwords from your users remain safe even in the event of a compromise.

These functions return a different output each time, even if the input password is the same.

```surql
crypto::argon2::generate('VerySecurePassword!');
crypto::argon2::generate('VerySecurePassword!');
```

That means that attackers can't store tables that hold passwords and their hashed outputs, because they will never be the same. All you can do is use a compare function that returns a boolean to tell you if it is a match or not.

```surql
LET $output = crypto::argon2::generate('VerySecurePassword!');
crypto::argon2::compare($output, 'VerySecurePassword!'); -- returns true
```

If you looked closely at the output, you might have noticed that it took a certain length of time. That's on purpose - the algorithms for these functions are made to be computationally expensive. Not so much that a user logging in would notice, but enough that a hacker trying every type of password won't be able to do it efficiently.

You can see the difference by running these functions fifty times inside a `FOR` loop, compared to a regular hashing function like `crypto::sha512()` that is meant to be efficient as opposed to cryptographically secure. The first loop will take about a second, while the second is almost instantaneous.

```surql
FOR $_ IN 0..50 {
    LET $result = crypto::argon2::generate('VerySecurePassword!');
    crypto::argon2::compare($result, 'VerySecurePassword!');    
};
FOR $_ IN 0..50 {
    crypto::sha512("VerySecurePassword!");
    crypto::sha512("VerySecurePassword!");
};
```

### role-based access control

Along with the different levels, SurrealDB implements role-based access control (RBAC) to further define what a user can do.

Each user is assigned one or more roles (currently limited to the built-in `OWNER`, `EDITOR` and `VIEWER` roles) and will be allowed to perform an action on a resource as long as at least one of their roles allows it.

The `OWNER` and `EDITOR` roles can view and edit any resource on the user's level or below. However, only the `OWNER` role can create users and other IAM resources such as access methods.

The `VIEWER` role can only view any resource on the user's level - and that's it.

### Least privilege

When assigning roles it's best practice to ensure that you employ the principle of least privilege and create users at the lowest level possible and with the minimum role in order to be able to perform their duties inside of SurrealDB. This will mitigate some of the risk in the case where credentials for that user are ever compromised.

An example of this is assigning the `VIEWER` permission to a user which only needs to perform read-only queries to the database.

```surql
DEFINE USER db_viewer ON DATABASE PASSWORD 'CHANGE_THIS' ROLES VIEWER;
```

## Record users

In addition to system users, SurrealDB also has another kind of user called a record user.

Record users are saved as a record in a database instead of being created through the `DEFINE USER` statement.

Since these users exist as regular database records, they can have associated fields containing any information required for authentication and authorisation.

Thanks to this, SurrealDB is able to offer mechanisms to define your own `SIGNIN` and `SIGNUP` logic as well as custom table and field permissions for record users. This feature contributes to making SurrealDB an all-in-one Backend-as-a-Service (BaaS).

Record users are defined with the [DEFINE ACCESS](/docs/reference/query-language/statements/define/access) statement of `TYPE RECORD`.

A record access is configured with the following specific clauses:

- `SIGNUP`: What happens when a user signs up as a record user and usually creates a new record in a table.

- `SIGNIN`: What happens when an attempt is made to sign in as a record user. Generally you will check credentials against table records here.

- `AUTHENTICATE`: Can be used to change the record identifier returned by the `SIGNUP` and `SIGNIN` clauses. If no record identifier is returned, it will return an error.

The `AUTHENTICATE` clause can also be used to log or stop authentication attempts from record users, as it is always executed across the `SIGNUP` and `SIGNIN` clauses.

By default, record users have no permissions. They don't use roles like system users do. Instead, they can only access data if allowed by a `PERMISSIONS` clause, which is defined on every data resource for example tables and fields and defaults to `NONE`.

### Record authentication example

Let's go over one of the many ways you can set up record authentication.

Given that you can define your own logic, there is not a single way to do it. Feel free to modify where needed!

### Define a user table and fields

Typically, you would define a user table where new records are created every time a user signs up. Here is a simple example of a `user` table and its related fields.

```surql
DEFINE TABLE user SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE id = $auth.id;
DEFINE FIELD name     ON user TYPE string;
DEFINE FIELD email    ON user TYPE string ASSERT string::is_email($value);
DEFINE FIELD password ON user TYPE string;
DEFINE FIELD enabled  ON user TYPE bool;
DEFINE INDEX email    ON user FIELDS email UNIQUE;
```

The fields result in the following:

- An authenticated user can select, update and delete its own user record.

- An assertion that the email provided by the user is a valid email address.

- Forbidding users to use an email that is already in use by another user. We do this by creating a unique index for the email field.

### Define the user record access

With the `user` table set up, we now need to define how to allow users to sign up and sign in. Here is a typical configuration.

```surql
DEFINE ACCESS user ON DATABASE TYPE RECORD
  SIGNUP (
    CREATE user CONTENT {
      name: $name,
      email: $email,
      password: crypto::argon2::generate($password),
      enabled: true
    }
  )
  SIGNIN (
    SELECT * FROM user WHERE email = $email
    AND crypto::argon2::compare(password, $password)
  )
  AUTHENTICATE {
    IF !$auth.enabled {
      THROW 'This user is not enabled';
    };
    RETURN $auth;
  };
```

Our configuration for record access works like this:

- The `SIGNUP` logic needs the `name`, `email` and `password` parameters to be provided by the user. In the query, we can use them as `$name`, `$email` and `$password`.

- The `SIGNIN` logic needs the `email` and `password` parameters to be provided by the user. In the query, we can use them as `$email` and `$password`.

The optional `AUTHENTICATE` clause is a good fit for validating specific conditions that are not expected to change during the lifetime of the session. In our example we validate whether a user is enabled or not. If the user in not enabled, we can use `THROW` to return a custom error message.

If the statements don't return anything, we'll just get a generic authentication error.

To learn more about creating a record user, refer to the [DEFINE ACCESS ... TYPE RECORD](/docs/reference/query-language/statements/define/access/record) documentation.

## Sessions

Whenever authentication is performed with any kind of user against SurrealDB, a session is established between the client and the SurrealDB server with which the connection was established.

These sessions exist only in memory on the server for the duration of the connection, whether it is a single request through the [HTTP REST API](/docs/reference/rest-api/http-protocol) or through multiple requests in the same connection using the [WebSocket API](/docs/reference/rest-api/rpc-protocol) and any of the [SDKs](/docs/languages/overview) that leverage it.

### Expiration

When defining [users](/docs/reference/query-language/statements/define/user) and [access methods](/docs/reference/query-language/statements/define/access), ensure that you set a specific [session and token duration](/docs/learn/security/authentication/authentication#expiration) whenever possible using the `DURATION` clause.

```surql
DEFINE USER username ON DATABASE
PASSWORD 'CHANGE_THIS'
DURATION FOR SESSION 5d;
DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP ( CREATE user SET email = $email, pass = crypto::argon2::generate($pass) )
  SIGNIN ( SELECT * FROM user WHERE email = $email AND crypto::argon2::compare(pass, $pass) )
  DURATION FOR SESSION 12h;
```

Default values provided by SurrealDB are intended to support cases where SurrealDB is used as a traditional backend database, which is why sessions do not expire by default.

If you are building an application where your end users will directly connect with SurrealDB, we strongly encourage setting a session expiration that is as short as possible (typically a few hours) to provide a good experience to your users without compromising security.

Expiring user sessions ensures that a user will not be able to remain authenticated long after their access has been revoked. This cannot be done on demand, as users sessions are not persisted in the database. However, unlike tokens, user sessions are not typically susceptible to be stolen, as they exist only in the context of an established WebSocket connection.

Tokens, however, are usually stored in the client, like a web browser, and may be stolen by client-side attacks such as a cross-site scripting vulnerability in your application. For this reason, we strongly recommend reducing token duration from the default one hour to the minimum amount of time that your use case can tolerate.

Ideally, a token should only be valid for as long as the client needs in order to use the token to establish a session, which can be as little as a few seconds.

```surql
DEFINE USER username ON DATABASE
PASSWORD 'CHANGE_THIS'
DURATION FOR TOKEN 15m;
DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP ( CREATE user SET email = $email, pass = crypto::argon2::generate($pass) )
  SIGNIN ( SELECT * FROM user WHERE email = $email AND crypto::argon2::compare(pass, $pass) )
  DURATION FOR TOKEN 5s;
```

When using `DEFINE ACCESS … TYPE RECORD`, authentication tokens issued to end users must have an expiration so `DURATION FOR TOKEN NONE` will be rejected. In practice, it is safest to use the shortest practical token lifetime for whatever application it is you are building.

## Query safety

When using SurrealDB as a traditional backend database, your application will usually build SurrealQL queries that may need to contain some untrusted input, such as that provided by the users of your application.

To do so, SurrealDB offers [`bind`](/docs/languages/rust/methods/query) as a method to `query` (implemented in other SDKs as [the `bindings` argument to `query`](/docs/languages/javascript/api/core/surreal-queryable#query)).

This should always be used when including untrusted input into queries. Otherwise, SurrealDB will be unable to separate the actual query syntax from the user input, resulting in the well-known [SQL injection](https://en.wikipedia.org/wiki/SQL_injection) vulnerabilities. This practice is known as [prepared statements or parametrised queries](https://en.wikipedia.org/wiki/Prepared_statement). Binding parameters ensures that untrusted data is passed to SurrealDB as SurrealQL parameters, which are independent from the query syntax, preventing SQL injection attacks.

```surql
// Rust SDK
// Do this:
let name = "john"; // User-controlled input.
let mut result = db
    .query("CREATE person SET name = $name")
    .bind(("name", name))
    .await?;
// Instead of this:
let mut result = db
    .query(format!("CREATE person SET name = {name}"))
    .await?;
```

```surql
// JavaScript SDK
// Do this:
let name = "john"; // User-controlled input.
let result = await db.query(
  "CREATE person SET name = $name;",
  { name: name }
);
// Instead of this:
let result = await db.query("CREATE person SET name = " + name + ";");
```

## Summary

We've covered quite a bit about security, let's summarise.

System user authentication uses `DEFINE USER` and consists of:

- Three levels of access to limit what users can do to the system: root, namespace or database.

- role-based access control, which further defines what a user can do, with the three built-in roles: `OWNER`, `EDITOR` and `VIEWER`.

Record user authentication uses `DEFINE ACCESS` and consists of:

- `SIGNUP`: Defines the logic for when a user signs up as a record user and usually creates a new record in a table.

- `SIGNIN`: Defines the logic for when a user signs in as a record user and usually checks credentials against table records.

- Permissions. By default, record users have no permissions. They don't use the role-based access control (RBAC) system and can only access data if allowed by a `PERMISSIONS` clause, which is defined on every data resource like tables and fields and defaults to `NONE`.

- `AUTHENTICATE`: Can be used to change the record identifier returned by the `SIGNUP` and `SIGNIN` clauses and is a good fit for validating specific conditions that are not expected to change during the lifetime of the session.

- Token duration: on `TYPE RECORD` access, `DURATION FOR TOKEN NONE` is rejected because end-user tokens must expire.

Here are some best practices to take away:

- Use the [password hashing functions](/docs/reference/query-language/functions/database-functions/crypto), such as `argon2` so that the passwords from your users remain safe even in the event of a compromise.

- Employ the principle of least privilege and create users at the lowest level possible and with the minimum role in order to be able to perform their duties inside of SurrealDB

- Ensure that you set a specific [session and token duration](/docs/learn/security/authentication/authentication#expiration) whenever possible using the `DURATION` clause and the shortest duration that is practical for your use case.

- Use [prepared statements](https://en.wikipedia.org/wiki/Prepared_statement) by binding parameters to ensure that untrusted data is passed to SurrealDB as SurrealQL parameters, these are independent from the query syntax, preventing SQL injection attacks.

I hope you enjoyed this session. See you in the next one!
