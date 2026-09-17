# Query capabilities

SurrealDB is a versatile database with numerous features and functionality. In this lesson, we'll cover how to allow and deny certain capabilities.

## Secure by default

SurrealDB is secure by default and is suitable for all database use cases. It offers powerful query capabilities like scripting, functions or network access from within your SurrealQL queries. There are command line flags to allow and deny certain capabilities. Denied capabilities override any allowed capabilities with matching options. When a query wants to use a capability that is not enabled, SurrealDB will reject it.

```surql
# Allow all query capabilities
$ surreal start --allow-all
# Explicitly override any allowed query capabilities
$ surreal start --allow-guests --deny-all
```

You can enable all the query capabilities using `--allow-all` , which is useful for experimenting with SurrealDB on your laptop. You can also use `--deny-all` to explicitly override any allowed query capabilities.

While `allow-all` might be useful for local experiments, its important to note that we strongly discourage running SurrealDB in production with all query capabilities enabled without a good reason for it. Instead, we recommend enabling only the capabilities that are necessary to your service.

For a full list of the query capabilities that SurrealDB supports and their details, you can [check out our documentation.](/docs/learn/security/authorization/capabilities)

For this lesson, we'll focus on network access, guest access and functions.

## Network access

As we've seen, SurrealDB offers `http` functions that can access external network endpoints.

We've already seen the `get` function, but we also have `put`, `post`, `patch`, `delete` and `head`.

```surql
RETURN http::get('url');
RETURN http::put('url');
RETURN http::post('url');
RETURN http::patch('url');
RETURN http::delete('url');
RETURN http::head('url');
```

If you want to allow or deny access to certain network targets, you can configure the network options accordingly.

```surql
# Deny network access to localhost and private IPv4 ranges
$ surreal start --allow-net --deny-net "127.0.0.1","localhost","10.0.0.0/8","192.168.0.0/16","172.16.0.0/12"
# Allow access to an internal system, but only to port 443
$ surreal start --allow-net internal.example.com:443
# Allow access to some private networks but not to others
$ surreal start --allow-net 10.0.0.0/16 --deny-net 10.10.0.0/24
```

As you can see in those examples, you can:

- Deny network access to localhost and private IPv4 ranges

- Allow access to an internal system, but only to a port like 443

- Allow access to some private networks but not to others

## Guest access

```surql
# Allow guest access
$ surreal start --allow-guests
# Deny guest access
$ surreal start --deny-guests
```

Guest access is used when you want to expose certain parts of a database to non-authenticated users. It's useful when you want to serve datasets publicly and still require authentication for the rest of the system.

Guest access is denied by default, but even when this capability is allowed, a guest user can only execute functions or CRUD operations like `CREATE` or `SELECT` for and only if the `PERMISSIONS` clause for the resource being used in the query allows it. Otherwise you'll get an error message such as `Not enough permissions to perform this action`.

## Functions

SurrealDB offers [built-in functions](/docs/reference/query-language/functions/database-functions/array) to perform common operations like string manipulation or math. Users can also define [their own functions](/docs/reference/query-language/statements/define/function) with custom logic.

In certain environments, you may not want users to use specific functions, such as the `http` functions, or execute any custom function at all. You can use the allow/deny lists to configure what functions are allowed and what functions are denied.

```surql
# Allow all functions except the http family and crypto::md5()
$ surreal start --allow-funcs --deny-funcs "http","crypto::md5"
# Allow certain custom functions only (all custom functions start with "fn::")
$ surreal start --allow-funcs "fn::shared_fn"
```

## Summary

To summarise, SurrealDB has many query capabilities such as network access, guest access and functions. You can use command line flags to allow and deny these capabilities

You'll find a full list of the query capabilities that SurrealDB supports and their details in our [documentation](/docs/learn/security/authorization/capabilities).

That's everything for this part on security, hope you've enjoyed it.
