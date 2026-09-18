# Chapter 20: Take three

**Time elapsed: ???**

## Triumph

> *It has been a long journey. 55 years ago a mere librarian, you now stand on the verge of restoring civilisation...and before a massive pile of notes on your desk. There are books somewhere underneath them, and you've scribbled on those too. Your habit of writing down your thoughts has helped though, especially in figuring out how to read the language of the past, a distant ancestor of modern English.*

> *Many of the inventions of the past have been rediscovered by now: the airplane, the personal computer, the phone...and many types of weaponry that still make you uncomfortable.*

> *You have been in talks with the governments of the world to recreate the internet. They have benefitted all this time from your centralised database, but are feeling its limits. Plus, it is just a matter of time. If they create the internet themselves, they will certainly dictate the rules in their favour. You will have to recreate the internet before they do if you want knowledge to continue to be free. You start writing down a plan for the next meeting with them in a handwriting so messy that only you can read it.*

> *Suddenly, you notice Landevin out of the corner of your eye, holding the grey book in his hand. He must have entered the room while you were sketching out your plan for the upcoming meeting.*

> *"I've solved the formula!"*

> *You detect a note of fear in his voice and forget all about the upcoming meeting. You've never once seen Landevin afraid. What is the matter?*

These Aeons sure are persistent! Persistence seems to be a value that they all share. Let's hope things turn out for the better this time.

And since we have another chapter to work with, let's use it to think about other tables in our movie database and the relations between them.

## Adding other tables and relations

We now have a large number of `movie` records that are in a format that lets us use SurrealDB's strengths when querying them, along with a strict schema for the single `movie` table.

We haven't used all of the relevant `naive_movie` data yet though, because there is some data that is best used in the creation of separate tables instead of putting everything into our `movie` table. Here is a sample of the fields we haven't made use of yet.

```surql
{
  Actors: 'Arnold Schwarzenegger, Linda Hamilton, Michael Biehn',
  Country: 'United Kingdom, United States',
  Director: 'James Cameron',
  Writer: 'James Cameron, Gale Anne Hurd, William Wisher',
}
```

This original `naive_movie` data has separate fields for directors, actors, and writers, but any single person can be a director, writer, or actor, or some combination of the three. Here's how we can represent this data:

- Define a `person` table with two fields: `name` (a string), and `roles` (an array of strings).

- Instead of just `CREATE`ing a movie, we'll use `LET $movie = CREATE ONLY...` to grab the output of `CREATE` so that it is ready to use for a later `RELATE` statement to join the movie to the people involved in creating it.

- After the `CREATE` statement for each movie, pull out each name from the `naive_movie`'s `Actors`, `Director`, and `Writer` fields.

- There might already be a `person` record that matches the name. If it doesn't exist, we can just create it and add the role.

- But if the `person` record already exists, we will have to see if the current role is already inside the `roles` field, because we don't want to add a duplicate value (i.e. we don't want `roles` to have values like `["actor", "actor", "actor", "director"]`). If not, then add it.

Let's start putting the queries together to create and modify the `person` records, starting with the actors in each movie.

After the `CREATE ONLY movie` statement, we still have access to the `$data` parameter that contains the original `naive_movie` data where the actors' names are. We can split this string into individual actor names, and then create a variable called `$actor` that will be the result of a query for a `person` of that name.

```surql
LET $movie = CREATE ONLY movie SET ... //
FOR $name IN $data.Actors.split(", ") {
  LET $actor = (SELECT * FROM ONLY person WHERE name = $name LIMIT 1);
};
```

At this point, `$actor` is going to either be a single `person` record, or `NONE`. We can now shadow the `$actor` variable through an `IF ELSE` statement so that it is guaranteed to not be none. If `$actor` is `NONE`, we will create it and add the string `"actor"` to its `roles`. And if it is not `NONE`, then we will add `"actor"` to its roles, but only if it doesn't include "actor" already.

After that, we just have to relate them. We can add a `RELATE` statement on the last line, where we are sure that we have a `$movie` record and an `$actor` record, neither of which are `NONE`. We'll call this relation `starred_in`.

Here is the whole block of code:

```surql
LET $movie = CREATE ONLY movie SET ... //
FOR $name IN $data.Actors.split(", ") {
  LET $actor = (SELECT * FROM ONLY person WHERE name = $name LIMIT 1);
  LET $actor = IF $actor IS NONE {
    (CREATE ONLY person SET name = $name, roles += "actor")
  } ELSE {
    IF "actor" NOT IN $actor.roles {
      UPDATE $actor SET roles += "actor"
    };
    $actor
  };
  RELATE $actor->starred_in->$movie;
};
```

There are many other ways to achieve the same thing, so feel free to experiment if you want to try out a query that fits your own style. For example, instead of checking whether the `roles` field already contains "actor", you could use the function `array::append()` to add "actor" to the `roles` array and then wrap this with `array::distinct()` which would remove any duplicates.

```surql
LET $actor = IF $actor IS NONE {
    (CREATE ONLY person SET name = $name, roles += "actor")
} ELSE {
    UPDATE $actor SET roles = $actor.roles.append("actor").distinct();
    $actor
};
```

The same block of code can be used for the directors (`$data.Director`) and writers (`$data.Writer`), with relation tables `directed` and `wrote`:

```surql
RELATE $director->directed->$movie;
RELATE $writer->wrote->$movie;
```

At the end, we can use almost the same block of code to create some `country` records that have a name and which are joined to movies by a `has_movie` table.

```surql
  FOR $name IN $data.Country.split(", ") {
  LET $country = (SELECT * FROM ONLY country WHERE name = $name LIMIT 1);
  LET $country = IF $country IS NONE {
    (CREATE ONLY country SET name = $name)
  } ELSE {
        $country
    };
    RELATE $country->has_movie->$movie;
    };
```

And before we put those relations in place, let's give each of these tables a definition to ensure that they can't be used for any other purposes. Note that the `roles` field for the `person` table, while an `array<string>`, in practice is almost an `option<array<string>>` because we can pass in an empty array for any `person` that doesn't have a job yet. If we wanted to ensure that each `person` definitely has a role, we could add an assertion, such as `ASSERT $value IS NOT NONE` or `ASSERT !!$value`.

```surql
DEFINE TABLE person SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name ON TABLE person TYPE string;
DEFINE FIELD roles ON person TYPE array<string>;
DEFINE TABLE country SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name ON TABLE country TYPE string;
DEFINE TABLE starred_in TYPE RELATION FROM person  TO movie;
DEFINE TABLE wrote      TYPE RELATION FROM person  TO movie;
DEFINE TABLE directed   TYPE RELATION FROM person  TO movie;
DEFINE TABLE has_movie  TYPE RELATION FROM country TO movie;
```

All these definitions now make for a pretty nice visual on SurrealDB Studio's Designer view, so be sure to give it a look! The schema makes it clear that there is a relation between all of the tables except the original `naive_movie` data, which is floating about on its own - as it should be.

## Graph queries on the database

With these relations set up, we can have some fun with graph queries! Since you can never get too much practice with graph queries, let's try putting a few together. To give you the chance to try them out yourself first, so let's start out by saying up front what each query should return.

How would you select...

- Every person's name and the titles of the movies that they starred in?

- Every movie's title and the names of the people that starred in it?

- The average rating of movies for people who worked on them?

- Country names, the titles of movies filmed in them, and their total box office value?

- Every person's name and the countries of the films they have been involved in?

- Every person's name, the countries and names of their films, ordered by the number of films they were in?

Now let's see the answers!

### Every person's name and the titles of the movies that they starred in

We can start `FROM person`, grab their `name`, and then `->starred_in->movie` to get to their movies. After that, just add `.title` to the end.

```surql
SELECT name,
    ->starred_in->movie.title AS starred_in
FROM person LIMIT 2;
```

**Response**

```surql
[
  {
    name: 'Connie Nielsen',
    starred_in: [
      'Gladiator'
    ]
  },
  {
    name: 'R. Lee Ermey',
    starred_in: [
      'Full Metal Jacket'
    ]
  }
]
```

### Every movie's title and the names of the people that starred in it

First we will start with `FROM movie`. And since we want the movies that have *been* `starred_in` by somebody, we'll turn the arrows around.

```surql
SELECT title,
    <-starred_in<-person.name AS stars
FROM movie LIMIT 2;
```

**Response**

```surql
[
  {
    stars: [
      'Alison Doody',
      'Sean Connery',
      'Harrison Ford'
    ],
    title: 'Indiana Jones and the Last Crusade'
  },
  {
    stars: [
      'Wendell Corey',
      'Grace Kelly',
      'James Stewart'
    ],
    title: 'Rear Window'
  }
]
```

### The average rating of movies for people who worked on them

This one is a bit tricky, because people can be involved in movies in one of three ways: acting, writing, and directing. Still, a path like `->starred_in->movie` simply leads to an array of `movie` records, so we can work from there.

To start, this query will show every movie that a person has been involved with.

```surql
SELECT
    name,
    ->(starred_in, wrote, directed)->movie AS movies
FROM person;
```

There is still some duplication though, such as when James Cameron was both the writer and director for the Terminator movies. This is easy to see if we show the `title` field for each movie.

```surql
SELECT
    name,
    ->(starred_in, wrote, directed)->movie.title AS movies
FROM person
WHERE name = "James Cameron";
```

**Response**

```surql
[
  {
    movies: [
      'Terminator 2: Judgment Day',
      'Aliens',
      'The Terminator',
      'Aliens',
      'Terminator 2: Judgment Day',
      'The Terminator'
    ],
    name: 'James Cameron'
  }
]
```

So we'll want to add an `array::distinct()` to remove those. After that, we can use the `.` operator to access the `average_rating` field, and then just `math::mean()` it.

And while we are at it, let's `ORDER BY average_rating DESC` to see who has the highest score!

```surql
SELECT
    name,
    math::mean(->(starred_in, wrote, directed)->movie.distinct().average_rating)
    AS average_rating
FROM person
ORDER BY average_rating DESC;
```

And if you wanted to make the results a bit more fair, we could add a line to limit the query to people who have been involved in at least two movies.

```surql
SELECT
    name,
    math::mean(->(starred_in, wrote, directed)->movie.distinct().average_rating) AS average_rating
FROM person
WHERE count(->(starred_in, wrote, directed)->movie) > 2
ORDER BY average_rating DESC;
```

### Country names, the titles of movies filmed in them, and their total box office value

This one is also a bit tricky, as a few movies in the database don't have a value for `box_office`. You can see the result in this query which shows a `NONE` every once in a while among the box office numbers.

```surql
SELECT
  name,
    ->has_movie->movie.{ title, box_office } AS info
FROM country;
```

And having even a single `NONE` value would cause the `math::sum()` function to return an error, as it expects an `array<number>` as its input.

```surql
math::sum([9, 8, NONE]);
-- Incorrect arguments for function math::sum(). Argument 1 was the wrong type. Expected `number` but found `NONE` when coercing an element of `array<number>`
```

But we can add a `WHERE` clause to only return movies where `box_office` exists. Let's try it with the !! syntax this time. We will also order by `box_office` and add `ASC` this time to see who has the lowest box office values of all amongst these movies.

```surql
SELECT name,
    ->has_movie->movie.title AS titles,
    math::sum((->has_movie->movie.box_office)[WHERE !!$this]) AS box_office
FROM country
ORDER BY box_office ASC
LIMIT 3;
```

The countries with the lowest box office values include one which doesn't even exist anymore!

```surql
[
  {
    box_office: 71909,
    name: 'Soviet Union',
    titles: [
      'Come and See'
    ]
  },
  {
    box_office: 613308,
    name: 'Denmark',
    titles: [
      'The Hunt'
    ]
  },
  {
    box_office: 613308,
    name: 'Sweden',
    titles: [
      'The Hunt'
    ]
  }
]
```

Good work! The next two queries are somewhat harder so let's take a quick break to see how Aeon and Landevin are doing this time around.

## The formula

> *You and Landevin did nothing but read and reread the formula this afternoon. But the conclusion is inescapable. You finally open your mouth to talk.*

> *"So we moved too fast?"*

> *Landevin: "Yes. We worked so hard on restoring the past that we didn't give people enough time to grow along with it."*

> *You: "Like people who win the jackpot in a lottery, spend it all in a month and end up worse than before?"*

> *Landevin: "Something like that, yes. We've given them knowledge and power that they had no time to prepare for. They could use it to destroy themselves, or just become addicted to the entertainment they provide and forget what it means to be human. Or something else...all we know is that humanity is doomed, and that it was about 10 years ago that it reached this point. If only I had only figured out the formula before then..."*

> *You: "But it's not too late, because we still hold most of the restored knowledge. We need to delete it, now. And - "*

> *Landevin: "And what?"*

> *You: "I can't shake the feeling that we're not the first people to try this. This tunnel has always had items that don't match with the futuristic technology, like the paintings on the wall and the heavy telephone on the desk. 21st century people never used telephones like that. It must have been rediscovered."*

> *Landevin: "You might be right. I think the ancients overestimated us when they put this book together."*

> *You: "They sure did. Every time we find this place, we notice the shiny toys first and forget about what matters. Until it's too late."*

> *Landevin: "Well, if we weren't the first, then maybe we won't be the last. And we have no time to clean up your notes either. Maybe the next people that find this place will benefit."*

> *You chuckle. "If they can read them, that is. I can barely make them out myself."*

## More graph queries on the database

Looks like no luck again this time for Aeon and Landevin. Let's get back to the last two graph queries before we move on to the next section.

### Every person's name and the countries of the films they have been involved in

Since there is a direct link from `movie` to `person` and `movie` to `country`, we will have to go from `person` to `movie` and then to `country` to get the countries that a person has been involved in.

First, let's look at the countries of the movies that people have `starred_in`.

```surql
SELECT
  name,
  (->starred_in->movie<-has_movie<-country.name).distinct() AS countries
FROM person
LIMIT 2;
```

**Response**

```surql
[
  {
    countries: [
      'United States'
    ],
    name: 'Carrie Fisher'
  },
  {
    countries: [],
    name: 'Martin Scorsese'
  }
]
```

We'll then use the same logic to add the results from `wrote` and `directed` as well.

```surql
SELECT
  name,
  (->(wrote, starred_in, directed)->movie<-has_movie<-country.name).distinct() AS countries
FROM person
LIMIT 2;
```

**Response**

```surql
[
  {
    countries: [
      'United States'
    ],
    name: 'Carrie Fisher'
  },
  {
    countries: [
      'United States',
      'France',
      'Hong Kong'
    ],
    name: 'Martin Scorsese'
  }
]
```

### Every person's name, the countries and names of their films, ordered by the number of films they were in?

This one is a bit tricky! The easiest way to make it work is by using a subquery that feeds into a main query. Take the following query for example which returns the names of the movies that someone has starred in, along with their count. It's close, but not quite what we need.

```surql
SELECT
  name,
  ->starred_in->movie.title AS movie_names,
  count(movie_names) AS num_movies
FROM person;
```

The problem is that `num_movies` will end up as 0 because `movie_names` has not yet been computed at the time that `count(movie_names)` is called.

```surql
[
  {
    movie_names: [
      'Star Wars: Episode V - The Empire Strikes Back',
      'Star Wars: Episode VI - Return of the Jedi',
      'Star Wars'
    ],
    name: 'Carrie Fisher',
    num_movies: 0
  }
]
```

To solve this, we can first put a query together that goes as far as all the movies that a person has been involved with. That can then be used to branch off into other areas: the names of the films, their number, and their countries.

Let's start with the subquery first.

```surql
SELECT
    *,
    (->(starred_in, wrote, directed)->movie).distinct() AS movies
FROM person;
```

**Response**

```surql
[
  {
    id: person:00mgcio443ymjdjm5unp,
    movies: [
      movie:vxa716jed4wx7p8sqddp,
      movie:ayl0dmwpg8g8e60e0fws,
      movie:ckxjhtg5vvx9dixfqte5
    ],
    name: 'Carrie Fisher',
    roles: [
      'actor'
    ]
  }
]
```

With this `movies` field ready to be pulled from, we can now count them, view their titles, and use the following line to see which countries they were filmed in.

```surql
(movies<-has_movie<-country).group().name AS countries
```

And since we now have a `num_movies` field that holds the number of movies per person, that allows us to add an `ORDER BY num_movies DESC` at the end.

```surql
SELECT
    name,
    count(movies) AS num_movies,
    movies.title AS movies,
    (movies<-has_movie<-country).group().name AS countries
    FROM
    (
        SELECT
        *,
        (->(starred_in, wrote, directed)->movie) AS movies FROM person
    )
ORDER BY num_movies DESC;
```

This gives us Christopher Nolan in first with 14 movies, followed by Charlie Chaplin and Stanley Kubrick in second place with 12 films each, and many more thereafter.

```surql
[
  {
    countries: [
      'United Kingdom',
      'United States',
      'Canada'
    ],
    movies: [
      'Inception',
      'Interstellar',
      'The Dark Knight',
      'The Dark Knight Rises',
      'Batman Begins',
      'Memento',
      'The Prestige',
      'Inception',
      'Interstellar',
      'The Prestige',
      'Batman Begins',
      'The Dark Knight Rises',
      'Memento',
      'The Dark Knight'
    ],
    name: 'Christopher Nolan',
    num_movies: 14
  },
  ...
]
```

## Defining events

Now it's time to start thinking about how people might actually use this database.

Let's imagine that our movie database has a number of users, many of which are allowed to delete movies. Sometimes a deletion makes sense, like after the following query that creates a new movie with the title "TEST TEST TEST".

To make the query as short as possible (because there are a lot of required fields for any `movie` record), we'll grab a single `movie` record and use its content to create a new movie with a different title.

```surql
LET $movie = SELECT * FROM ONLY movie LIMIT 1;
CREATE movie CONTENT UPDATE ONLY $movie SET title = "TEST TEST TEST";
```

**Response**

```surql
[
  {
    average_rating: 89.33333333333333f,
    awards: 'Won 2 Oscars. 79 wins & 87 nominations total',
    box_office: 293004164,
    dvd_released: d'2009-11-10T00:00:00Z',
    genres: [
      'Animation',
      'Adventure',
      'Comedy'
    ],
    id: movie:0bz6th2env33sbfvv2kt,
    imdb_rating: 82,
    languages: [
      'English'
    ],
    metacritic_rating: 88,
    oscars_won: 2,
    plot: '78-year-old Carl Fredricksen travels to Paradise Falls in his house equipped with balloons, inadvertently taking a young stowaway.',
    poster: 'https://m.media-amazon.com/images/M/MV5BMTk3NDE2NzI4NF5BMl5BanBnXkFtZTgwNzE1MzEyMTE@._V1_SX300.jpg',
    rated: 'PG',
    released: d'2009-05-29T00:00:00Z',
    rt_rating: 98,
    runtime: 1h36m,
    title: 'TEST TEST TEST'
  }
]
```

This one should definitely be deleted, but what about movies that don't deserve to be removed forever? If a user can delete the movie called "TEST TEST TEST", it can also delete any other movies as well.

To ensure that good data doesn't just disappear forever, we can define an event that keeps an eye out for DELETE events for the `movie` table, and sticks the data inside a table called `deleted_movie` just in case.

```surql
DEFINE EVENT soft_deletion ON TABLE movie WHEN $event = "DELETE" THEN {
    CREATE deleted_movie CONTENT $before;
};
```

With this event defined, we can now see the data inside `deleted_movie` after the movie called "TEST TEST TEST" is removed.

```surql
LET $movie = SELECT * FROM ONLY movie LIMIT 1;
CREATE movie CONTENT UPDATE ONLY $movie SET title = "TEST TEST TEST";
DELETE movie WHERE title = "TEST TEST TEST";
SELECT * FROM deleted_movie;
```

The same movie data will now show up, except that its id will be something like `deleted_movie:0bz6th2env33sbfvv2kt`.

Since the `deleted_movie` table is automatically generated, we don't need to think about defining a strict schema for it. And it will default to `PERMISSIONS NONE` so that only users with the correct level of permissions can modify them.

```surql
naive_movie: 'DEFINE TABLE naive_movie TYPE ANY SCHEMALESS PERMISSIONS NONE',
```

## Defining a few params

We added some assertions to our database in the last chapter to make sure that a movie's genres or rating could only be one of a few values, such as 'Biography', 'Family', and 'PG-13':

```surql
DEFINE FIELD genres ON TABLE movie TYPE array<string>
  ASSERT $value ALLINSIDE ['Action','Adventure', 'Animation',  'Biography', 'Comedy',  'Crime', 'Drama', 'Family',  'Fantasy', 'Film-Noir',  'History', 'Horror', 'Music', 'Musical', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War',  'Western'];
DEFINE FIELD rated ON TABLE movie TYPE option<string>
  ASSERT $value IN ['Approved', 'G', 'Not Rated', 'PG', 'PG-13', 'Passed', 'R', 'TV-PG', 'Unrated', 'X'];
```

This works great, but we could improve it a little. If we think about it, genres and ratings are values that are relevant to a lot of other sections of the database, not necessarily just the `genres` and `rated` fields of the `movie` table.

For example, a user who tries to enter a movie might appreciate seeing a list of the possible genres, which would not be available if they are only used as an assertion for a field. So let's move these out into their own params that we will call `$GENRES` and `$RATINGS`.

```surql
DEFINE PARAM $GENRES VALUE  ['Action','Adventure', 'Animation',  'Biography', 'Comedy',  'Crime', 'Drama', 'Family',  'Fantasy', 'Film-Noir',  'History', 'Horror', 'Music', 'Musical', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War',  'Western'];
DEFINE PARAM $RATINGS VALUE ['Approved', 'G', 'Not Rated', 'PG', 'PG-13', 'Passed', 'R', 'TV-PG', 'Unrated', 'X'];
```

The assertions in the `DEFINE FIELD` statements for `genres` and `rated` will now pull from these global parameters.

```surql
DEFINE FIELD genres ON TABLE movie TYPE array<string>  ASSERT $value ALLINSIDE $GENRES;
DEFINE FIELD rated  ON TABLE movie TYPE option<string> ASSERT $value IN $RATINGS;
```

Having these global parameters is already giving us new ideas for how to use them, such as a function that returns a movie from a random genre and rating.

```surql
DEFINE FUNCTION fn::random_movie() {
    LET $random_genre = rand::enum($GENRES);
    LET $random_rating = rand::enum($RATINGS);
    LET $title = RETURN "Movies for " + $random_genre + " and " + $random_rating;
    RETURN [$title, (SELECT * FROM movie WHERE $random_genre IN genres AND $random_rating IN rated)];
};
```

Much of the time the function will happen upon a combination that returns nothing, but that is because our database isn't very large yet. But a combination like 'Adventure' and 'R' will show a good number of movies.

```surql
RETURN fn::random_movie();
```

The output will look something like this.

```surql
[
  'Movies for Adventure and R',
  [
    {
      average_rating: 76.33333333333333f,
      awards: 'Won 5 Oscars. 59 wins & 106 nominations total',
      box_office: 187705427,
      dvd_released: d'2000-09-26T00:00:00Z',
      genres: [
        'Action',
        'Adventure',
        'Drama'
      ],
      id: movie:0q6if78lnn8awz9y1yjh,
      imdb_rating: 85,
      languages: [
        'English'
      ],
      metacritic_rating: 67,
      oscars_won: 5,
      plot: 'A former Roman General sets out to exact vengeance against the corrupt emperor who murdered his family and sent him into slavery.',
      poster: 'https://m.media-amazon.com/images/M/MV5BMDliMmNhNDEtODUyOS00MjNlLTgxODEtN2U3NzIxMGVkZTA1L2ltYWdlXkEyXkFqcGdeQXVyNjU0OTQ0OTY@._V1_SX300.jpg',
      rated: 'R',
      released: d'2000-05-05T00:00:00Z',
      rt_rating: 77,
      runtime: 2h35m,
      title: 'Gladiator'
    },
    {
      average_rating: 91.66666666666667f,
      awards: '3 wins & 6 nominations',
      box_office: 25100000,
      dvd_released: d'2006-11-07T00:00:00Z',
      genres: [
        'Adventure',
        'Western'
      ],
      id: movie:n4vjjsvevv6xk39bhd8k,
      imdb_rating: 88,
      languages: [
        'Italian'
      ],
      metacritic_rating: 90,
      plot: 'A bounty hunting scam joins two men in an uneasy alliance against a third in a race to find a fortune in gold buried in a remote cemetery.',
      poster: 'https://m.media-amazon.com/images/M/MV5BNjJlYmNkZGItM2NhYy00MjlmLTk5NmQtNjg1NmM2ODU4OTMwXkEyXkFqcGdeQXVyMjUzOTY1NTc@._V1_SX300.jpg',
      rated: 'R',
      released: d'1967-12-29T00:00:00Z',
      rt_rating: 97,
      runtime: 2h58m,
      title: 'The Good, the Bad and the Ugly'
    },
    {
      average_rating: 88.33333333333333f,
      awards: 'Won 2 Oscars. 20 wins & 23 nominations total',
      box_office: 85160248,
      dvd_released: d'1999-06-01T00:00:00Z',
      genres: [
        'Action',
        'Adventure',
        'Sci-Fi'
      ],
      id: movie:qxb028webjzhat4h4h05,
      imdb_rating: 84,
      languages: [
        'English'
      ],
      metacritic_rating: 84,
      oscars_won: 2,
      plot: 'Fifty-seven years after surviving an apocalyptic attack aboard her space vessel by merciless space creatures, Officer Ripley awakens from hyper-sleep and tries to warn anyone who will listen about the predators.',
      poster: 'https://m.media-amazon.com/images/M/MV5BZGU2OGY5ZTYtMWNhYy00NjZiLWI0NjUtZmNhY2JhNDRmODU3XkEyXkFqcGdeQXVyNzkwMjQ5NzM@._V1_SX300.jpg',
      rated: 'R',
      released: d'1986-07-18T00:00:00Z',
      rt_rating: 97,
      runtime: 2h17m,
      title: 'Aliens'
    },
    {
      average_rating: 80.33333333333333f,
      awards: 'Won 1 Oscar. 133 wins & 172 nominations total',
      box_office: 120540719,
      dvd_released: d'2009-12-15T00:00:00Z',
      genres: [
        'Adventure',
        'Drama',
        'War'
      ],
      id: movie:rl2cj9ityo4mxifzma1p,
      imdb_rating: 83,
      languages: [
        'English',
        'German',
        'French',
        'Italian'
      ],
      metacritic_rating: 69,
      oscars_won: 1,
      plot: "In Nazi-occupied France during World War II, a plan to assassinate Nazi leaders by a group of Jewish U.S. soldiers coincides with a theatre owner's vengeful plans for the same.",
      poster: 'https://m.media-amazon.com/images/M/MV5BOTJiNDEzOWYtMTVjOC00ZjlmLWE0NGMtZmE1OWVmZDQ2OWJhXkEyXkFqcGdeQXVyNTIzOTk5ODM@._V1_SX300.jpg',
      rated: 'R',
      released: d'2009-08-21T00:00:00Z',
      rt_rating: 89,
      runtime: 2h33m,
      title: 'Inglourious Basterds'
    }
  ]
]
```

We are once again short on room and will have to pick up in the next chapter - assuming that this third Aeon does the same thing as the last two and that another Aeon will try in another few centuries. Let's find out if that is the case.

## A farewell to civilisation

> *You informed the world's governments that your database would be unavailable for half a day while "major improvements" were made. 12 hours should be enough to delete the database, shut the security door, and get on the airplane waiting to take you to a place where nobody has ever heard of you. In any case, the world will soon be too busy with other matters to care about where you disappeared to.*

> *A sense of panic sets in as you turn to leave your office. You grab wildly at a few of your notes, looking for something, anything. You need more time! What if you've misunderstood the formula? It feels wrong to just react to it like this. What if...*

> *But it's too late. You need to give humanity another chance to start again.*

> *Inside the control room, you set the security door to close for the maximum duration - one "age" - and chuckle bitterly as you remember that day half a century ago when you thought you would never need to use it. A door that locks for a few centuries, but never longer...just enough time to ensure that a new age has begun. The ancients certainly chose the name well. Perhaps the people of another age will find this place again once the door reopens and do a better job next time. But for now, you and your team have a plane to catch.*

![Two people with wheeled suitcases standing at the boarding stairs of a small white private jet on a runway at dusk, an airfield control tower rising behind the aircraft.](/assets/static/part-20-plane-boarding.CQfB5UPU.avif)
