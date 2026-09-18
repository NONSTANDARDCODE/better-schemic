# 1: Connecting to a database

The examples in this course are inside mini windows of their own that look like this...

```surql
-- Returns a string
"Click on the 'Run Query' button to run this query!";
-- Also returns a string
RETURN 
    "Results display without needing the RETURN keyword, " + 
    "but you can add it if you want";
```

...and this.

```surql
"Just don't forget"
"the semicolon between statements"
"or you will get an error."
"Add some semicolons to make these statements work!"
```

You don't need to install SurrealDB or create your own connection to run any of them.

But you can also run the examples in a more manual way, if you prefer. Here is how to do it.

- The SurrealDB Studio sandbox: go to the [SurrealDB Studio website](https://studio.surrealdb.com/) which defaults to a Sandbox connection, and use that in a separate window. You can copy and paste query samples there. The data won't be erased unless you click on "Reset sandbox environment" or reload the window.

- Using SurrealDB Cloud: go to [the website for SurrealDB Studio](https://studio.surrealdb.com/current/instances/deploy) app, click on SurrealDB Cloud and sign up for a free instance.

- Locally: [Install SurrealDB in your machine](/surrealdb/install), then type [`surreal start --user root --pass root`](/docs/reference/cli/surrealdb-cli/commands/start) in a terminal window to start the server with a single root user. Then [connect using SurrealDB Studio](/docs/explore/surrealist/getting-started#creating-a-connection) or use the command `surreal sql --user root --pass root --pretty` in a second terminal window to connect [using the CLI](/docs/reference/cli/surrealdb-cli/overview).
