# Chapter 21: Breaking out

**Time elapsed: ???**

## Triumph

> *It has been a long journey. 50 years ago a mere librarian, you now stand on the verge of restoring civilisation.*

> *It took you a long time to decipher the books in the tunnel, which surprisingly were in a very old form of the English you speak. The notes scattered throughout the tunnel took a long time too. Given how messy they were, you assumed that they were in a completely different language. What a shock it was when you realised that they were in almost modern English! They were written by someone in the same situation as you, just a few centuries ago.*

> *The notes were instrumental in helping you restore the things of the past. Reinventing the telephone and the airplane was nice, but your favourite was the machine that plays those mirror-like discs in the library called M-DISCs, or DVDs.*

> *As far as you can tell, the people before you were too busy with other inventions to figure out how to use the DVDs in the library. Their loss! After a lot of effort, you finally managed a few years ago to recreate the machines that play them. Instead of just reading about the ancient world, you can both see and hear it! What a difference that made in the way you viewed the ancient world. Where you once felt awe for it, you now feel affection. And a sense of responsibility to put things right where they failed.*

> *You have been in negotiations with the governments of the world to recreate the internet. They have benefitted from your centralised database, but are feeling its limits. Plus, it is just a matter of time. No country is as advanced as yours, but they are progressing. And if they create the internet themselves, they will certainly dictate the rules in their favour. To keep the flow of information free, you will have to recreate the internet before they do.*

> *There is a sudden knock on the door. You set your cup of tea down on your desk and look up. It's Landevin, holding the grey book in his hand.*

> *"I've solved the formula!"*

> *He finally solved it!*

> *"Congratul-" you begin to say, but stop as you detect the note of fear in his voice. What is the matter?*

It looks like the notes from the last version of Aeon have been a big help. Let's hope for the best.

## Defining a database and adding system users

Now that our database setup is looking pretty good, we can start to think about adding some users so that we can give access to the database with more limited permissions. And to get into a more long-term feel, let's move away from the Sandbox (if that's what you are using) and practice saving the content of the database to file. In fact, none of the examples in this chapter are embedded because practicing them requires signing in to the database using a number of different types of connections.

The easiest options here are SurrealKV or RocksDB, which can be started with one of the following commands.

```surql
surreal start --user root --password root surrealkv://surrealbook.db
surreal start --user root --password root file://surrealbook.db
```

You should see a few lines of output, ending with the following:

```surql
2025-12-19T03:15:07.373643Z  INFO surrealdb_core::kvs::ds: Credentials were provided, and no root users were found. The root user 'root' will be created
2025-12-19T03:15:07.397743Z  INFO surrealdb::net: Started web server on 127.0.0.1:8000
```

With the database running, let's now open up SurrealDB Studio, create a new connection, and sign in as the root user we just created. Then we'll define a namespace and database, both called `movies`.

While we are at it, let's define a `CHANGEFEED` on the database. It's easy to do, and being able to use queries like `SHOW CHANGES FOR TABLE country SINCE 0` might come in handy later on.

```surql
DEFINE NAMESPACE movies;
USE NAMESPACE movies;
DEFINE DATABASE movies CHANGEFEED 3d;
USE DATABASE movies;
```

Now that we are inside the database, we'll create three database level users that each have a different role.

```surql
DEFINE USER owner  ON DATABASE PASSWORD "owner"  ROLES OWNER;
DEFINE USER editor ON DATABASE PASSWORD "editor" ROLES EDITOR;
DEFINE USER viewer ON DATABASE PASSWORD "viewer" ROLES VIEWER;
```

Now let's paste in all the data from the last chapter after the seven statements above so that there is some information to search through.

With that done, we can start to practice connecting as one of these system users instead of as the root user. To start, let's rename the current connection called 'New connection' on the top left to Root so that we know which connection it is. You can do that by hovering the mouse over `New connection` on the top left, clicking on `Edit connection` and changing the name from `New connection` to `Root`.

We will then create three new connections that have user names and passwords that match the define statements above, one for each new user that we just created. This will make it easy to switch between them all so we can test out the permissions they have been given.

Once they are done, you should see a total of four connections.

If you prefer to test out these connections via the CLI, you can do so by adding `--auth-level database` to the `surreal sql` command. This will let the database know that you intend to log in as a database user, as opposed to the default which will assume that you are trying to log in as a root user.

```surql
surreal sql --auth-level database --user owner  --pass owner  --ns movies --db movies --pretty
surreal sql --auth-level database --user editor --pass editor --ns movies --db movies --pretty
surreal sql --auth-level database --user viewer --pass viewer --ns movies --db movies --pretty
```

You can specify `namespace` when using `--auth-level`, and even `root`. We haven't needed to use `--auth-level` until this chapter though because `surreal sql` assumes a root level unless otherwise specified. As such, the two commands below have the same result.

```surql
surreal sql                   --user root --pass secret
surreal sql --auth-level root --user root --pass secret
```

Now let's test this out. If we switch to the owner connection, a query for `RETURN $session` should show some data that includes the user's name: 'owner'.

```surql
{
  ac: NONE,
  db: 'movies',
  exp: NONE,
  id: '4af6b705-4fc7-4b25-82e7-b9bee95dc10e',
  ip: '127.0.0.1',
  ns: 'movies',
  or: NONE,
  rd: NONE,
  tk: {
    DB: 'movies',
    ID: 'owner',
    NS: 'movies',
    exp: 1725942758,
    iat: 1725939158,
    iss: 'SurrealDB',
    jti: '460e1b6a-f062-481f-adf6-1deb5bac06b8',
    nbf: 1725939158
  }
}
```

Most of the abbreviations in the session data are clear at first sight, but here is some explanation for the parts that might not be.

- `ac`: The access method used to use the database. Since we aren't logged in as a record user, we didn't use an access method and thus this is set to NONE.

- `exp`: The expiry date. We have no expiry date because by default a `DEFINE USER` has no session expiry. These durations have been inserted after our own `DEFINE USER` statements because we didn't specify a specific duration ourselves. Inside `INFO FOR DB` you can see that the definition for our current connection shows up as `"DEFINE USER editor ON DATABASE PASSHASH '[REDACTED]' ROLES EDITOR DURATION FOR TOKEN 1h, FOR SESSION NONE"`.

- `or`: The current connection origin.

- `rd`: The current record authentication data, which shows up as `NONE` here as well.

- `tk`: The current authentication token. Note that this has an expiry date because the `DEFINE USER` statement includes a `DURATION FOR TOKEN 1h` clause. We will practice using tokens to log in shortly.

The expiry dates inside the session data represent the number of seconds since the UNIX epoch. For a more readable layout, we can use the function `time::from_secs()` which will convert seconds into a datetime.

```surql
SELECT
    time::from_secs(tk.exp) AS token_expiry,
    exp,
    tk.ID AS user
FROM $session;
```

**Response**

```surql
[
  {
    exp: NONE,
    token_expiry: d'2025-01-10T04:32:38Z',
    user: 'owner'
  }
]
```

With the option to log in as other users, we should now be more limited than when we were logged in as the root user.

As an owner, we can do anything as long as it is on the database level. But trying to modify items on the database level are now out of our reach.

```surql
// Works fine
DEFINE USER new_user ON DATABASE PASSWORD "new_user";
// Works for root owner
DEFINE NAMESPACE other_namespace;
USE NAMESPACE other_namespace;
// Works for root or namespace owner, but not database owner
INFO FOR NS;
DEFINE USER new_user ON NAMESPACE PASSWORD "new_user";
```

The editor is still fairly powerful, and can modify items all across the database level. But definition statements are now forbidden.

```surql
// Works fine
CREATE formula SET content = "IMPORTANT!!! CALCULATE AND TRACK THE OUTPUT OF THE FORMULA. Having said that, let's begin...";
SELECT * FROM movie;
// Works for owner, but not editor
DEFINE USER new_user ON DATABASE PASSWORD "new_user";
```

Finally comes the lowly viewer, who is able to view but unable to modify anything.

```surql
// Works fine
SELECT * FROM movie;
// But nothing can be modified
UPDATE FORMULA UNSET content;
```

## The formula

> *You and Landevin did nothing but read over the formula in silence this afternoon. Again, and again, and again. But the conclusion seems inescapable. You finally open your mouth to talk.*

> *"If I'm reading this correctly...we moved too fast?"*

> *Landevin: "Yes. We worked so hard on restoring the past that we didn't give the people enough time to grow along with it."*

> *You: "So they have modern technology without realising that it can be used for the wrong purposes?"*

> *Landevin: "That's right. They have the tools, but lack the memory. They will soon have the technology to destroy the world without a shared memory of the horror of it. Or they may become addicted to the convenience and...*

> *As Landevin continues to talk, you press your fingertips together and think, staring at the formula. It feels like the formula is staring back at you, lifeless, in black and white from the paper it is printed on. Who made it, and why? What was its intended use?*

> *"Do you trust the formula?" you say, without looking up.*

> *Landevin sounds surprised. "Trust? It's not a matter of trust. We've studied it for decades, and it's rock solid. That's a fact."*

> *You: "This feels like a good time for a walk."*

> *Landevin: "What?"*

> *You stand up. "This is where we decide to delete the database for the sake of humanity, right? Like the others before us did? It feels like someone is standing right behind me, pushing me forward, and doesn't want me to turn around."*

> *Landevin: "That's a creepy thought."*

> *You: "It is. But I'm not ready to step forward just yet. And anyhow, what's the rush? If we have to delete the database, we can at least spend half a day thinking about it first. Let's go outside."*

Finally something different is happening! This feels like a good sign. Let's hurry up and get to the next part of our database while there is still time: adding record users.

## Adding record users

Our database now has a number of system users, but it would be nice to allow others to sign up without needing us to log in to manually create them. As we saw in Chapter 15, we can use a `DEFINE ACCESS` statement to do so.

To make the signup and signin logic as simple as possible, let's create a `user` table that has two fields called `name` and `pass`. For the ultimate in simplicity, we won't even require a user to have an email, just a name. A `DEFINE INDEX` statement can be used here to make sure that `name` has to be unique.

After that, we will define the `user` table to allow a user to see its own record via `PERMISSIONS FOR select WHERE $auth.id = id`. After this, the `DEFINE ACCESS` statement will be the same as the simplest example in the documentation except that the user only has a name and a password.

```surql
DEFINE TABLE user SCHEMAFULL
    PERMISSIONS FOR select WHERE $auth.id = id;
DEFINE FIELD name ON TABLE user TYPE string;
DEFINE FIELD pass ON TABLE user TYPE string;
DEFINE INDEX unique_name ON TABLE user FIELDS name UNIQUE;
DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP ( CREATE user SET name = $name, pass = crypto::argon2::generate($pass) )
  SIGNIN ( SELECT * FROM user WHERE name = $name AND crypto::argon2::compare(pass, $pass) )
  DURATION FOR TOKEN 15m, FOR SESSION 12h;
```

Once this is done, we will need to set up some permissions, as record users by default aren't allowed to access anything. The first thing we would like is to let the database know that `SELECT` statements are okay for a record user to use. Here too we can make the logic extremely simple, by allowing `SELECT` on these tables to work as long as there is *some* value for `$auth.id` - in other words, as long as the record user is logged in. This could be written as `WHERE $auth.id IS NOT NONE`, or `WHERE !!$auth.id`. We'll go with the former for the sake of readability.

On top of this, another nice feature to have would be for a user to be able to create and delete any of these tables, as long as the user was the one who created it. One way to do this would be to give each table a `created_by` field, which is an `option<record<user>>`. With this, we could set up the permissions to create and delete using `FOR create, delete WHERE $created_by = $auth.id`. Having this field would also add the benefit of system users being able to quickly see which `movie`, `country`, or `person` records were made by a record user.

We can also allow users to use `UPDATE` statements using the condition `WHERE $created_by = $auth.id`, but we don't want them to be able to modify the `created_by` field. To solve this, we can set `created_by` as `READONLY` and give it the value of `$auth.id`. Once one of these records is set, its `created_by` value will be set in stone and no user can hide the fact that it created a record.

All together, that means that our `DEFINE TABLE` statements will become a lot longer, and that there will be some `DEFINE FIELD` statements to set up the `created_by` fields for them all.

```surql
DEFINE TABLE movie SCHEMAFULL TYPE NORMAL
    PERMISSIONS
        FOR select WHERE $auth.id IS NOT NONE
        FOR create, update, delete WHERE created_by = $auth.id;
DEFINE TABLE person SCHEMAFULL TYPE NORMAL
    PERMISSIONS
        FOR select WHERE $auth.id IS NOT NONE
        FOR create, update, delete WHERE created_by = $auth.id;
DEFINE TABLE country SCHEMAFULL TYPE NORMAL
    PERMISSIONS
        FOR select WHERE $auth.id IS NOT NONE
        FOR create, update, delete WHERE created_by = $auth.id;
DEFINE TABLE starred_in TYPE RELATION FROM person  TO movie
    PERMISSIONS
        FOR select WHERE $auth.id IS NOT NONE
        FOR create, update, delete WHERE created_by = $auth.id;
DEFINE TABLE wrote TYPE RELATION FROM person TO movie
    PERMISSIONS
        FOR select WHERE $auth.id IS NOT NONE
        FOR create, update, delete WHERE created_by = $auth.id;
DEFINE TABLE directed   TYPE RELATION FROM person  TO movie
    PERMISSIONS
        FOR select WHERE $auth.id IS NOT NONE
        FOR create, update, delete WHERE created_by = $auth.id;
DEFINE TABLE has_movie TYPE RELATION FROM country TO movie
    PERMISSIONS
        FOR select WHERE $auth.id IS NOT NONE
        FOR create, update, delete WHERE created_by = $auth.id;
DEFINE FIELD created_by ON TABLE movie      TYPE option<record<user>> READONLY VALUE $auth.id;
DEFINE FIELD created_by ON TABLE person     TYPE option<record<user>> READONLY VALUE $auth.id;
DEFINE FIELD created_by ON TABLE country    TYPE option<record<user>> READONLY VALUE $auth.id;
DEFINE FIELD created_by ON TABLE starred_in TYPE option<record<user>> READONLY VALUE $auth.id;
DEFINE FIELD created_by ON TABLE wrote      TYPE option<record<user>> READONLY VALUE $auth.id;
DEFINE FIELD created_by ON TABLE directed   TYPE option<record<user>> READONLY VALUE $auth.id;
DEFINE FIELD created_by ON TABLE has_movie  TYPE option<record<user>> READONLY VALUE $auth.id;
```

Alternatively, you could also define the permissions for `created_by` field to only be selectable for a user if it matches the id of the currently logged-in user. But that is more of a design decision than a security decision. We might want to have the database be a collaborative one where users can see which other users created which records, in which case you wouldn't want to add a `PERMISSIONS` clause to the `DEFINE FIELD` statements. But feel free to give it a try if you want to keep this field hidden to anyone but the user that created a record!

While we are at it, let's add a `PERMISSIONS NONE` to the end of all of our functions to ensure that the record users can't use them...except for `fn::random_movie()`, which might be nice for a record user to use. While all of the functions we have defined are simple helper functions that don't affect the database, there is no reason for a record user to need them. And we don't need to give record users any special insight into how we built the database either.

Doing this is easy: add `PERMISSIONS NONE` to the end of every function, and change `DEFINE FUNCTION` to `DEFINE FUNCTION OVERWRITE` if necessary.

## Signing in as a record user

With our record users set up, it's time to try creating one. We can give this a try ourselves by using the two [built-in HTTP endpoints](/docs/reference/rest-api/http-protocol#example-with-a-record-user) that allow us to sign up and in: `/signup` and `/signin`.

To give this a try, open up a terminal window and paste in the following command using curl, or through an app like Postman that allows you to make HTTP requests. We haven't created a user yet, so we will need to use the `/signup` endpoint. The `"ac":"account"` part refers to the name of the `DEFINE ACCESS` statement above: `DEFINE ACCESS account`. Make sure to change `"account"` to something else if you choose a different name for a `DEFINE ACCESS` statement of your own.

```surql
curl -X POST -H "Accept: application/json" -d '{"ns":"movies","db":"movies","ac":"account","name":"user","pass":"password"}' http://localhost:8000/signup
```

A successful output should look something like this.

```surql
{
  "code":200,
  "details":"Authentication succeeded",
  "token":"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpYXQiOjE3MjU4NjA1NjEsIm5iZiI6MTcyNTg2MDU2MSwiZXhwIjoxNzI1ODYxNDYxLCJpc3MiOiJTdXJyZWFsREIiLCJqdGkiOiJlYjliOTYxYi04ODNmLTQ5NDEtOTQ5Yy02NTc5YjJmMDc1YmUiLCJOUyI6Im1vdmllcyIsIkRCIjoibW92aWVzIiwiQUMiOiJhY2NvdW50IiwiSUQiOiJ1c2VyOjFoNnlqamhxZDB6NThvMnhxMGtrIn0.GD8Fv8Hf_GwgR-rw5cAMO4KIXC7dVHaoCEVLlJD6ThTJLPVgqIGL25nSx5x4VrklWrjgePu6jz8JHVaerzUFlA"
}
```

The `token` inside the output is what we can use to authenticate ourselves as a record user. You can then copy this token after the end of a `surreal sql` command that ends with the flag `--token`, like this.

```surql
surreal sql --ns movies --db movies --token "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpYXQiOjE3MjU4NjA1NjEsIm5iZiI6MTcyNTg2MDU2MSwiZXhwIjoxNzI1ODYxNDYxLCJpc3MiOiJTdXJyZWFsREIiLCJqdGkiOiJlYjliOTYxYi04ODNmLTQ5NDEtOTQ5Yy02NTc5YjJmMDc1YmUiLCJOUyI6Im1vdmllcyIsIkRCIjoibW92aWVzIiwiQUMiOiJhY2NvdW50IiwiSUQiOiJ1c2VyOjFoNnlqamhxZDB6NThvMnhxMGtrIn0.GD8Fv8Hf_GwgR-rw5cAMO4KIXC7dVHaoCEVLlJD6ThTJLPVgqIGL25nSx5x4VrklWrjgePu6jz8JHVaerzUFlA"
```

Because the `DEFINE ACCESS account` statement we have has a `DURATION FOR TOKEN 15m`, this token will have to be used within 15 minutes, but the session established with it will last for 12 hours, as we defined a `DURATION FOR SESSION 12h`. Because this user named `user` and password of `password` is inside the database, you can change the endpoint from `/signup` to `/signin`, and the output will contain a fresh token that will once again give you up to 15 minutes to sign in.

```surql
curl -X POST -H "Accept: application/json" -d '{"ns":"movies","db":"movies","ac":"account","name":"user","pass":"password"}' http://localhost:8000/signin
```

### Making your own frontend to sign up as a user

If you are a developer yourself, you could put your own frontend together.

At the time of publication of this book, there is a single frontend built in Rust that you can try out here:

- [A Rust frontend using the egui crate](https://github.com/surrealdb/examples/tree/main/surreal-book/movie-database-rust-egui/readme.md)

To build your own frontend that includes signing up and signing in as a record user, take a look for methods with the names `.signup()` and `.signin()` in one of SurrealDB's SDKs, such as [the SDK for JavaScript](/docs/languages/javascript/concepts/authentication), [for Python](/docs/languages/python/concepts/authentication), or [for .NET](/docs/languages/dotnet/methods/signup).

If you have built your own frontend that handles the movie database in these last chapters, let us know and we'll add it to the list!

Now that we are signed in, let's try some queries out to see what life is like as a record user.

### Testing record user permissions

Life as a record user is certainly different from a system user, because all of our permissions are strictly defined. In some ways we can do things that a system user with a `VIEWER` role can't do, such as creating and updating records, but only inside a limited scope - those that we made ourselves. In fact, a record user was even known as a "scope user" in the oldest versions of SurrealDB.

Let's get to some queries. Since the `movie` table has a lot of required fields, we'll test out the record user's permissions by creating something much simpler: a country. This table only has a single defined field, as the `INFO FOR TABLE` statement shows.

```surql
INFO FOR TABLE country;
```

**Response**

```surql
'IAM error: Not enough permissions to perform this action'
```

Ah yes, that's right. We don't have access to that command as a record user. However, trying to create a `country` without a value for the `name` field will at least inform us in the error message that this field is required.

```surql
CREATE country;
```

**Response**

```surql
'Found NONE for field `name`, with record `country:5mjs361jl38awfsz7dvn`, but expected a string'
```

Let's give it a try with the country called Bishkek.

```surql
CREATE country SET name = "Bishkek";
```

**Response**

```surql
[
    {
        created_by: user:yhn5hdsr3jiw25bvi1ay,
        name: "Bishkek"
    }
]
```

Oops! That's the name of a city and not a country. Let's hurry to delete it before anybody notices. This will also give us the opportunity to see what happens when we try to delete every record in a table as a record user.

```surql
DELETE country;
SELECT * FROM country;
```

Our permissions only allowed us to delete the single record that had a `created_by` field that matched the current `$auth.id`, and as a result, the only country has been deleted is the "country" of Bishkek. All the rest of them are still there, untouched.

**Response**

```surql
[
  {
    id: country:2fe4c5jemcvksgwn9b9g,
    name: 'United States'
  },
  {
    id: country:2upr67mcvbeu5wwe63dm,
    name: 'Spain'
  },
    ...
]
```

Finally, let's `CREATE` the country that has Bishkek as its capital, this time properly. It's Kyrgyzstan.

```surql
CREATE ONLY country SET name = "Kyrgyzstan";
```

**Response**

```surql
[
  {
    created_by: user:2qxq93qhyjdo73yk1pbo,
    id: country:tb0zf3lcizyjjfynw5b3,
    name: 'Kyrgyzstan'
  }
]
```

It would be nice for one of Kyrgyzstan's movies to be in our database, so let's look for one. It seems that one made in the late 1990s was particularly successful, so we'll add it.

```surql
CREATE ONLY movie SET
    genres = ["Drama", "Family"],
    imdb_rating = 69,
    languages = ["Kyrgyz"],
    plot = "A happy-go-lucky Kyrgyz lad learns he is adopted as he begins his transition to adulthood.",
    rt_rating = 100,
    released = <datetime>"1998-06-01",
    runtime = 81m,
    title = "Beshkempir";
```

Note the `created_by` field in the movie which shows that we as a record user are the author.

**Response**

```surql
[
  {
    average_rating: 84.5f,
    created_by: user:2qxq93qhyjdo73yk1pbo,
    genres: [
      'Drama',
      'Family'
    ],
    id: movie:qkdnpv2hkhe4ubjlnkvg,
    imdb_rating: 69,
    languages: [
      'Kyrgyz'
    ],
    plot: 'A happy-go-lucky Kyrgyz lad learns he is adopted as he begins his transition to adulthood.',
    released: d'1998-06-01T00:00:00Z',
    rt_rating: 100,
    runtime: 1h21m,
    title: 'Beshkempir'
  }
]
```

After this, we will be a good database citizen and relate the country that we just added to this movie.

```surql
LET $country = SELECT * FROM ONLY country WHERE name = "Kyrgyzstan" LIMIT 1;
LET $film = SELECT * FROM ONLY movie WHERE title = "Beshkempir" LIMIT 1;
RELATE $country->has_movie->$film;
```

**Response**

```surql
[
  {
    created_by: user:2qxq93qhyjdo73yk1pbo,
    id: has_movie:77614z1p113xwnp02h8c,
    in: country:j2lnvlyfuc9lqq6nv3bx,
    out: movie:z8ebku7ovha82it7j1ov
  }
]
```

The database is looking pretty good! Let's add a little bit more functionality and then call it a day.

## Keeping track of the record users

In the last chapter we defined an event that created a `deleted_movie` record every time a movie is deleted. This was done for the benefit of our system users, and can't be viewed by the record users.

While the record users don't have the freedom to do very much, they can still create and update records of their own. We don't want them to create all sorts of spam via `CREATE` and `UPDATE`, and we also don't want them to remove all the data they added via `DELETE` if they one day decide to rage quit.

One way to make this a bit easier is by adding some more events. These will simply track any and all events for these tables, because they all involve a change in state for the data and we would like to keep an eye on that. These events can be made for the three main tables. Every time the database detects an event, it will update the user to add the event, the input data, and the time at which the event happened.

And since the `user` table is schemafull, we can define this `actions` field as a flexible array of objects. This will make it easy to add more data later on if we feel like updating these events.

We will also need to add a `WHEN` clause ensuring that `$auth IS NOT NONE` (or `!!$auth`, if you prefer that syntax), because `$auth` will be an empty value when signed in as a system user and then SurrealDB will error with the complaint that it is unable to update something with the value of `NONE`.

```surql
DEFINE FIELD actions ON TABLE user TYPE option<array<object>> FLEXIBLE;
DEFINE EVENT movie_activity ON TABLE movie WHEN $auth IS NOT NONE THEN {
  UPDATE $auth SET  
        actions += {
            event: $event,
            input: $value,
            at: time::now()
        }
};
DEFINE EVENT country_activity ON TABLE country WHEN $auth IS NOT NONE THEN {
  UPDATE $auth SET  
        actions += {
            event: $event,
            input: $value,
            at: time::now()
        }
};
DEFINE EVENT person_activity ON TABLE person WHEN $auth IS NOT NONE THEN {
  UPDATE $auth SET  
        actions += {
            event: $event,
            input: $value,
            at: time::now()
        }
};
```

Once these events have been set up, it is now easier to keep an eye on users with bad intentions, like this one.

```surql
CREATE country SET name = "Smurftown";
CREATE person SET name = "Lolllllllㅎㅎㅎㅎㅎ", roles = ["actor"];
```

A quick look through SurrealDB Studio's Data Explorer shows which records have a `created_by` field, which makes it easy to track the records that have been created by record users. And a look at the actions of all of our `user` records shows that this user has indeed been creating records that should not be created.

```surql
[
  {
    actions: [
      {
        at: d'2025-12-23T04:43:03.949Z',
        event: 'CREATE',
        input: {
          created_by: user:mg4i62w7hwoh8ukt333t,
          id: country:zf6514r6451dgq36un3q,
          name: 'Smurftown'
        }
      },
      {
        at: d'2025-12-23T04:43:54.409Z',
        event: 'CREATE',
        input: {
          created_by: user:mg4i62w7hwoh8ukt333t,
          id: person:vcmvhsdmlt2zkmie0nqk,
          name: 'Lolllllllㅎㅎㅎㅎㅎ',
          roles: [
            'actor'
          ]
        }
      }
    ],
    id: user:mg4i62w7hwoh8ukt333t,
    name: 'barglbargl',
    pass: '$argon2id$v=19$m=19456,t=2,p=1$aIGErokC+d0xz+LDNBr6gA$v3OSC0psa09R5PnaXsxdsqomLmmfYfxPEXL/FX3heq0'
  }
]
```

Anything beyond this point will be left to you to pick up, as we are now out of space and out of time. Let's wrap it up!

## Final thoughts and possible expansion

Well! That should be enough to get you started. Over the last four chapters we have put together a movie database that works pretty well. You can use it through SurrealDB Studio, the CLI, or through a frontend of your own that you might want to put together. And most importantly, it has real data over a good 150 movies that you might be interested in checking out yourself. It's a small database, but one with real utility.

And it has many areas that you might want to pick up and start improving, because no database is perfect. You probably have some ideas of your own already, but here are a few others to think about:

- Though we have events that show us which users are doing what, it might be nice if record users were able to signal to you in some way that a record is inaccurate or simply spam. Maybe you could allow them to create records called `report` that require a record link to the record in question, along with another field where they can write what the problem is. You could then look up all the users with reports that mention them. Or you could implement this idea in your own way.

- Since the world only has a finite list of countries, you could insert them all manually. But a lot of countries have various names, such as South Korea which is also known as "Korea", "Republic of Korea", and sometimes even shows up as "Republic of Korea, the". Maybe full text search could help here?

- While record users can only delete records that they create themselves, they can still start creating records as soon as they sign up. That could lead to a lot of weird spam. How about changing the permissions for a record user can only use `SELECT` at first, and then other operations only after a certain period of time has passed? A `future` that calculates a user's time since creation might work here.

- Sometimes a record user will notice something wrong in a record created by another user, but can't modify it. How could you let record users make requests for corrections to records in the database that they can't modify themselves?

- Alternatively (or in addition), how about letting record users simulate modifying other records by letting them create something like a `local_movie` or `local_country` or `local_user` that shows up in their queries so that they don't have to wait for others to approve any changes?

For example, take this movie which has an incorrect date.

```surql
CREATE movie SET title = 'Some movie', year = 1950;
```

But if the record user is allowed to create its own record with the correct date...

```surql
CREATE local_movie SET title = 'Some movie', year = 1951;
```

When that record can be retrieved instead of the incorrect one, without having to wait for the managers of the database to approve any changes. It would then require some sort of filter to make sure that `local_movie` records with the same title are shown first.

```surql
LET $filter = "Some movie";
LET $local_search = SELECT * FROM local_movie WHERE title = $filter;
RETURN IF !!$local_search {
    $local_search
} ELSE {
    SELECT * FROM movie WHERE title = $filter;
};
```

```surql
[
  {
    id: local_movie:nnvosucgbuxca7vtp377,
    title: 'Some movie',
    year: 1951
  }
]
```

Or maybe you'd like to...well, you get the idea. There really is no end to the number of ways we could add functionality to this database.

---

Now let's see what Aeon and Landevin are doing this chapter. We are done our movie database mini-project, but what are they going to do? Let's see what they have decided.

## A farewell to failure

> *After a pleasant afternoon hike, you and Landevin have found a nice place to sit down that offers a view of the city below. The sun will be setting soon, but it's late spring and still warm. Your thoughts have now come together, and you open your mouth to speak.*

> *"I'm not going to delete the database."*

> *Landevin: "I feared as much. I'm going to have to do it myself then."*

> *You: "No, I don't think you will."*

> *Landevin chuckles. "And how do you know that?"*

> *You: "Because we always agree in the end, even if we approach things differently. Tell me, how do you think the formula was created in the first place?"*

> *Landevin: "I have two theories. It might have been a terrible disaster, after which the survivors created the formula and the tunnel to give future generations a chance to try again. Or the other way around. They might have found the formula first, believed in it, and then waged a long campaign to destroy the internet. Either way, humanity had the chance to try again, but with a guide this time."*

> *You: "Is that what you think the formula was meant to be? A guide for action? Not a warning?"*

> *Landevin: "What do you mean?"*

> *You: "I can explain with a story, I think. I was rewatching one of my favourite movies the other day, the one about an event that doomed humanity."*

> *Landevin: "The depressing one with the killer robots that you always talk about?"*

> *You: "That's the one! But I don't find it depressing, rather the opposite. In the movie, a person from the future was sent back in time to just the right place, and he was able to prevent a disaster from happening. Just one person with a warning made all the difference! There's a quote in it that goes something like this: "The future's not set. There's no fate but what we make for ourselves." Don't you see? That's what is happening to us!"*

> *Landevin: "So...the formula is sort of like a messenger from the future?"*

> *You: "Precisely! Even though it was made in the distant past, it's future technology. That bakes it a message about our own future. It's telling us what *will* happen to us if we don't change. Now that we understand it, it's like we've been visited by someone from the future who is telling us to open our eyes. And..."*

> *Landevin: "What else?"*

> *You: "Besides being a warning, the formula also feels like a test to me. Think about it. It compares our technological level to the progress we make as humans, right?"*

> *Landevin: "Right. It compares the two to see whether the "human" part is still dominant. And if it's not, we're doomed."*

> *You: "And how *human* do you think it is to trust our entire fate to the output of a formula?"*

> *Landevin pauses for a bit. "Maybe not that human."*

> *You: "And don't the old books and movies always feature a hero who makes the right decision even when it makes the most sense to give in and give up?"*

> *Landevin: "You know, I think you're on to something here. That stubborn refusal to lose hope is about as human as it gets."*

> *You: "Exactly. Whether its creators meant it or not, I think it has a deeper meaning. It's a challenge to see if we will take the easy way out by running away and letting future generations try again for us. And that's what we've done each and every time. But not again. No, we won't reset humanity again."*

> *Landevin: "And then what?"*

> *You: "The whole world still depends on our database and listens to us, so I'm going to tell them about the formula and the warning it holds. Then we lay it aside and start the conversation among ourselves. No formulas, no numbers, just us. Because the formula from start to finish is about us, nothing else."*

> *Landevin sighs and smiles. "50 years into the project and it feels like this is where it actually begins!"*

> *You: "You've got that right. We have a lot of work ahead of us."*

![Two figures sitting under a large tree on a grassy hillside at sunrise, one of them reading a book, looking out over cultivated fields towards a distant walled town, with an aeroplane's vapour trail crossing the sky above.](/assets/static/part-21-end.DO7q4hcA.avif)
