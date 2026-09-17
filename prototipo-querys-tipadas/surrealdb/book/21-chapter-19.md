# Chapter 19: Aeons later

**Time elapsed: ???**

## Triumph

> *It has been a long journey. You were young when you found this library and its oddly charming German folktale paintings that seem so out of place in such a futuristic setting. 45 years have passed since then, and you now stand on the verge of restoring civilisation. Most of the inventions of the past have been rediscovered: the airplane, the personal computer, the phone...and many types of weaponry that went along with it.*

> *The fools will probably destroy all your progress with them one day...*

> *You have been in talks with the governments of the world to recreate the internet and let knowledge flow free. They have benefitted all this time from your centralised database, but are feeling its limits. Plus, it is just a matter of time. No country is as advanced as yours, but they are progressing. If you don't recreate the internet before they do, they will control the flow of information to suit their own needs.*

> *There is a sudden knock on the door. You set your cup of black coffee down on your desk and look up. It's Landevin, holding the grey book in his hand. "I've solved the formula!"*

> *You've been dreading this day since the first time you found that damn book. You detect a note of fear in his voice too.*

> *"Let's take a look at what you've got, Landevin."*

We seem to have arrived at the point in time in which the next group of people also began thinking about recreating the internet. We call them Aeon and Landevin too, since they seem to be in the same roles as before.

Let's wish them luck as we get back to the movie database that we were putting together. Now where were we?

## Continuing the movie database

We spent the last chapter deciding how to turn the original JSON data into something more useful, one field at a time. Our work led to [the current dataset here](https://datasets.surrealdb.com/learn/book/book-part-18-movies.surql). We still have a few fields left to go, so let's continue from that point.

### Awards

The `Awards` field in the original movie data is mostly unpredictable, as this query shows:

```surql
SELECT VALUE Awards FROM naive_movie;
```

**Response**

```surql
[
  'Won 3 Oscars. 57 wins & 74 nominations total',
  'Won 4 Oscars. 121 wins & 126 nominations total',
  'Nominated for 4 Oscars. 15 wins & 37 nominations total',
  'Nominated for 1 BAFTA Film Award39 wins & 103 nominations total',
  'Won 1 Oscar. 22 wins & 25 nominations total',
  -- ...
]
```

Even the number of nominations isn't always greater than the number of wins!

```surql
'Nominated for 4 Oscars. 8 wins & 6 nominations total',
```

So trying to calculate a 'percentage of nominations won' wouldn't be worth it here. The data simply isn't good enough.

However, there is one part that seems to be formatted in the same way every time: "Won", followed by a number, followed by how many Oscars were won. We can see that with this query:

```surql
SELECT Awards FROM naive_movie WHERE "Oscar" IN Awards AND "Won" IN Awards LIMIT 3;
```

**Response**

```surql
[
  {
    Awards: 'Won 1 Oscar. 89 wins & 50 nominations total'
  },
  {
    Awards: 'Won 1 Oscar. 18 wins & 22 nominations total'
  },
  {
    Awards: 'Won 1 Oscar. 16 wins & 12 nominations total'
  }
]
```

This can be used to create a field called `oscars_won`, which will return either an integer of the number of Oscars won, or NONE. This will require a few lines of code, so we'll make a function to do it. The function will do the following:

- Check if 'Won ' and 'Oscar' are inside the string, returning `NONE` if both of these are not present.

- Otherwise, use `string::replace()` to remove 'Won ' from the front, then split the string by ' Oscar'. The part remaining at the 0th index will be the number, which can be cast into an `int`.

Here is a quick example of this string replacing and splitting with one of the `Awards` strings from above.

```surql
LET $replaced = 'Won 1 Oscar. 89 wins & 50 nominations total'.replace('Won ', '');
RETURN $replaced;
RETURN $replaced.split(' Oscar')[0];
```

**Response**

```surql
-------- Query --------
'1 Oscar. 89 wins & 50 nominations total'
-------- Query --------
'1'
```

Now we just have to add an `<int>` cast to the final output, and put it into a function.

```surql
DEFINE FUNCTION fn::get_oscars($input: string) -> option<int> {
  RETURN IF $input.starts_with('Won ') AND 'Oscar' in $input {
      LET $input = $input.replace('Won ', '');
      <int>$input.split(' Oscar')[0]
  } ELSE {
      NONE
  }
};
```

Next, let's create five `movie` records from the `naive_movie` data to see what the `oscars_won` field looks like. Most of them haven't won any, but a few have.

```surql
FOR $data IN SELECT * FROM naive_movie LIMIT 4 {
    CREATE movie SET
        title = $data.Title,
        oscars_won = fn::get_oscars($data.Awards);
};
SELECT title, oscars_won FROM movie;
```

**Response**

```surql
[
  {
    oscars_won: NONE,
    title: 'A Clockwork Orange'
  },
  {
    oscars_won: 1,
    title: 'A Separation'
  },
  {
    oscars_won: 1,
    title: 'Alien'
  },
  {
    oscars_won: NONE,
    title: 'Your Name.'
  }
]
```

Note that the `NONE` in `oscars_won` represents a lack of data, not a claim that the movie didn't win any Oscars. This `Awards` field in the original data is certainly too varied and unstructured to be taken as a real source of truth. In any app that uses this data, we should just display nothing or `N/A` when the `oscars_won` field turns out to be NONE.

Now let's delete these `movie` records again and get on to the next field.

### BoxOffice, DVD

These two fields are not a huge challenge. We already made our own `fn::date_to_datetime` function to convert date formats like '21 Dec 1999' to a datetime, and the dollar values like '$136,381,073' for `BoxOffice` can be converted to numbers after removing the dollar sign and commas. But there is one more small item to note. You might have noticed this already when eyeballing the data, but this query will make it more obvious:

```surql
SELECT BoxOffice, DVD
    FROM naive_movie
    WHERE
        BoxOffice.len() < 5 OR
        DVD.len() < 5;
```

**Response**

```surql
[
  {
    BoxOffice: 'N/A',
    DVD: 'N/A'
  },
  {
    BoxOffice: 'N/A',
    DVD: 'N/A'
  },
  {
    BoxOffice: 'N/A',
    DVD: '01 May 2005'
  },
    ...
]
```

We can see that the database we got this information from uses `N/A` to represent a lack of data instead of something like NULL or NONE. So we will need to do a quick check for these fields to see if they are equal to 'N/A', and set them as NONE if that is the case.

Let's give this a try now by creating some `movie` records with just these two fields (plus a title). Then we'll try a query with `ORDER BY` to see which ones made the most money.

```surql
FOR $data IN SELECT * FROM naive_movie {
    CREATE movie SET
        title = $data.Title,
        box_office = IF $data.BoxOffice = 'N/A' { NONE } ELSE { <int>$data.BoxOffice.replace('$', '').replace(',', '') },
            dvd_released = IF $data.DVD = 'N/A' { NONE } ELSE { <datetime>fn::date_to_datetime($data.DVD) };
};
SELECT
  title,
  dvd_released,
  box_office
FROM movie
ORDER BY box_office DESC // or ORDER BY dvd_released for DVD release date
LIMIT 5;
```

The data looks good! We are able to properly sort the data by these two fields. The query above shows us the movies that had the most success at the box office:

```surql
[
  {
    box_office: 858373000,
    dvd_released: d'2019-07-30T00:00:00Z',
    title: 'Avengers: Endgame'
  {
    box_office: 800588139,
  },
    dvd_released: NONE,
    title: 'Spider-Man: No Way Home'
  },
  {
    box_office: 678815482,
    dvd_released: d'2018-08-14T00:00:00Z',
    title: 'Avengers: Infinity War'
  },
  {
    box_office: 534987076,
    dvd_released: d'2008-12-09T00:00:00Z',
    title: 'The Dark Knight'
  },
  {
    box_office: 460998507,
    dvd_released: d'2005-12-06T00:00:00Z',
    title: 'Star Wars'
  },
    ...
]
```

Note that the above query works because we are sure that this data will contain a `'N/A'` string if no `BoxOffice` data is present. If we were working with other data that might have other strings like "Not available" or "Nothing" for lack of box office data, we could use another method. This other method involves first replacing the `$` and `,` signs, and then calling the `string::is_numeric()` function on it. If the resulting string isn't a string entirely composed of numbers, we know that the data isn't valid and will pass on a `NONE` instead.

```surql
FOR $data IN SELECT * FROM naive_movie {
    LET $replaced = $data.BoxOffice.replace('$', '').replace(',', '');
    CREATE movie SET
        title = $data.Title,
        box_office = IF $replaced.is_numeric() { <int>$replaced } ELSE { NONE },
            dvd_released = IF $data.DVD = 'N/A' { NONE } ELSE { fn::date_to_datetime($data.DVD) };
};
```

That takes care of all of the fields that need work! There are a lot of other fields that don't need any modification such as `title`, `plot`, and `poster` (a url to an image of the movie's poster). But we will work with these fields soon on the schema level.

Putting everything together that we have so far, this single query will allow us to take each of the `naive_movie` records and turn them into `movie` records that are much easier to use for real data analysis.

```surql
FOR $data IN SELECT * FROM naive_movie {
    CREATE movie SET
        awards = $data.Awards,
    box_office = IF $data.BoxOffice = 'N/A' { NONE } ELSE { <int>$data.BoxOffice.replace('$', '').replace(',', '') },
    dvd_released = IF $data.DVD = 'N/A' { NONE } ELSE { fn::date_to_datetime($data.DVD) },
    genres = $data.Genre.split(', '),
    imdb_rating = fn::get_imdb($data.Ratings),
    languages = $data.Language.split(', '),
    metacritic_rating = fn::get_metacritic($data.Ratings),
    oscars_won = fn::get_oscars($data.Awards),
        plot = $data.Plot,
        poster = $data.Poster,
        rated = $data.Rated,
    released = fn::date_to_datetime($data.Released),
        rt_rating = fn::get_rt($data.Ratings),
        runtime = <duration>$data.Runtime.replace(' min', 'm'),
        title = $data.Title;
};
```

## Adding a schema

Now that we have changed the fields from the original `naive_movie` data into something more useful, it's time to start thinking about our database schema. Adding a schema will allow us to start adding other `movie` records as new movies are released, without allowing any unexpected data to get added.

We definitely want to add some other tables besides `movie`, but we'll focus on the fields of our `movie` records first. We can give each field a type, while some will also have an assertion or two. Finally, while the `plot` field is just a string, it has a ton of useful content that we will be able to make best use of by defining a search analyzer and an index so that full text search will work on it.

We'll start with some basic `DEFINE` statements. Right now our `movie` table has been defined as a `SCHEMALESS` table of `TYPE ANY`, as the output from an `INFO FOR DB` command shows.

```surql
tables: {
  movie: 'DEFINE TABLE movie TYPE ANY SCHEMALESS PERMISSIONS NONE',
  naive_movie: 'DEFINE TABLE naive_movie TYPE ANY SCHEMALESS PERMISSIONS NONE'
}
```

So our first task will be to define `movie` as a schemafull table that is `TYPE NORMAL`, which will ensure that nobody can use it in a `RELATE` statement.

The rest of the statements will each specify the type of some of the fields, many of which are optional. That should be enough strictness for these fields.

```surql
DEFINE TABLE OVERWRITE movie SCHEMAFULL TYPE NORMAL;
DEFINE FIELD awards            ON TABLE movie TYPE option<string>;
DEFINE FIELD box_office        ON TABLE movie TYPE option<int>;
DEFINE FIELD dvd_released      ON TABLE movie TYPE option<datetime>;
DEFINE FIELD genres            ON TABLE movie TYPE array<string>;
DEFINE FIELD imdb_rating       ON TABLE movie TYPE option<int>;
DEFINE FIELD languages         ON TABLE movie TYPE array<string>;
DEFINE FIELD metacritic_rating ON TABLE movie TYPE option<int>;
DEFINE FIELD oscars_won        ON TABLE movie TYPE option<int>;
DEFINE FIELD plot              ON TABLE movie TYPE string;
DEFINE FIELD released          ON TABLE movie TYPE datetime;
DEFINE FIELD rt_rating         ON TABLE movie TYPE option<int>;
DEFINE FIELD runtime           ON TABLE movie TYPE duration;
DEFINE FIELD title             ON TABLE movie TYPE string;
```

It will also be useful to add a field that computes the average rating of a movie, so let's add that. The `math::mean()` function will compute the average, but we will first need to filter out any values that are not `NONE`.

```surql
DEFINE FIELD average_rating ON TABLE movie COMPUTED math::mean([imdb_rating, metacritic_rating, rt_rating][WHERE $this IS NOT NONE]);
```

You could also have used `[WHERE !!$this]` if you prefer, or `.filter(|$v| $v IS NOT NONE)` or `.filter(|$v| !!$v)`, and so on.

Following this, we have two fields that we could add some assertions to: `poster`, and `rated`. The `poster` field holds a url that contains the movie's poster, so it should be a string that passes the `string::is_url()` test.

Before we define this field, let's first make sure that every `poster` field we have passes the test. An `array::distinct()` function should do the trick. If every value passes `string::is_url()`, we should only see the output `true`.

And that is what we see!

```surql
RETURN (SELECT VALUE Poster.is_url() FROM naive_movie).distinct();
```

**Response**

```surql
[
  true
]
```

Since all of the original data passes this condition, we can define the field with the assertion. Let's make it an `option<string>` just in case we have any movies to add later on that don't have a poster url that we can refer to.

```surql
DEFINE FIELD poster ON TABLE movie TYPE option<string> ASSERT $value.is_url();
```

The second to last field to define is `rated`, which represents how appropriate the movie is for certain age groups. Let's take a look at all the values in the movie data that we currently have to see what sort of ratings there are. A quick `array::distinct()` plus an `array::sort()` should do the trick:

```surql
RETURN (SELECT VALUE Rated from naive_movie).distinct().sort();
```

The output shows only ten ratings, which makes this perfect for an assertion.

```surql
[
  'Approved',
  'G',
  'Not Rated',
  'PG',
  'PG-13',
  'Passed',
  'R',
  'TV-PG',
  'Unrated',
  'X'
]
```

To ensure that only one of these values can be passed in, we'll add an `ASSERT $value IN` plus all of these values. This one can also be an `option<string>` in case a movie needs to be added that hasn't received a rating yet. Apparently movies only get rated about 4 weeks before they start filming, so optional is the only way to go here.

Here is the field's definition:

```surql
DEFINE FIELD rated ON TABLE movie TYPE option<string>
  ASSERT $value IN ['Approved', 'G', 'Not Rated', 'PG', 'PG-13', 'Passed', 'R', 'TV-PG', 'Unrated', 'X'];
```

We can do the same with the genres, which we can see with a query similar to the previous one except that we need to split each string so that we can see each genre.

```surql
RETURN (SELECT VALUE Genre.split(', ') FROM naive_movie).group().sort();
```

Because `genres` is an array of strings, we can't simply assert `$value IN`. It won't work because `IN` is expecting a `string` when asked to see if a certain value is inside an array, but it doesn't know what to do with another `array<string>`.

```surql
RETURN ["Adventure", "Animation"] IN ["Action", "Adventure", "Animation"]; // Returns false
```

We can use the `ALLINSIDE` operator instead, which will check to see if *each* of the values is present, as this simple example shows.

```surql
RETURN ["one", "two"] ALLINSIDE ["three", "two", "one"]; // Returns true
```

All together, that gives us the following definition.

```surql
DEFINE FIELD genres ON TABLE movie TYPE array<string>
  ASSERT $value ALLINSIDE ['Action','Adventure', 'Animation',  'Biography', 'Comedy',  'Crime', 'Drama', 'Family',  'Fantasy', 'Film-Noir',  'History', 'Horror', 'Music', 'Musical', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War',  'Western'];
```

With the schema finished, let's take a quick break to see how Aeon and Landevin are doing this time around.

## The formula

> *You and Landevin did nothing but read over the formula in silence this afternoon. Again, and again, and again. But the conclusion is inescapable. You finally open your mouth to talk.*

> *"So we did move too fast."*

> *Landevin: "Yes. We worked so hard on restoring civilisation that we didn't give the people enough time to grow along with it."*

> *You: "And now they have all this tech but no memory of what happens when it is used for evil."*

> *Landevin: "Exactly that. They will soon have the technology to destroy the world without a shared memory of the horror of it. Or they may become addicted to the convenience and forget what it means to be human. Or something else. I'm not sure."*

> *You point to a page in the book. "And it looks like the tipping point was about 10 years ago. We almost solved the formula then but got distracted with other inventions and trying to play nice with all the countries that want our knowledge. Damn it! I can't believe we wasted our time reinventing the stupid television when the book clearly told us to pay attention to the formula."*

> *Landevin: "You know, most of the knowledge that the world relies on is still inside our database. Nobody else has it...so I guess we both know what we have to do now."*

> *You: "We do indeed. I'm going to miss this place."*

Looks like no luck this time.

We are going to have to move quickly before Aeon and Landevin delete everything. Let's get to the next feature that we'll add to our movie database: full text search to make it as easy as possible to find just the right movie.

## Adding full text search

Our `movie` table has three fields that are freeform strings. Let's take a look at a small sample of a few of them.

```surql
SELECT awards, plot, title FROM movie LIMIT 3;
```

**Response**

```surql
[
  {
    awards: 'Won 1 Oscar. 15 wins & 15 nominations total',
    plot: 'After two male musicians witness a mob hit, they flee the state in an all-female band disguised as women, but further complications set in.',
    title: 'Some Like It Hot'
  },
  {
    awards: 'Won 3 Oscars. 59 wins & 124 nominations total',
    plot: 'A working-class Italian-American bouncer becomes the driver of an African-American classical pianist on a tour of venues through the 1960s American South.',
    title: 'Green Book'
  },
  {
    awards: 'Won 2 BAFTA Film 12 wins & 12 nominations total',
    plot: 'A former Prohibition-era Jewish gangster returns to the Lower East Side of Manhattan 35 years later, where he must once again confront the ghosts and regrets of his old life.',
    title: 'Once Upon a Time in America'
  }
]
```

But of these, `title` and `plot` are important enough that adding full text search makes sense. As was the case with the Sherlock Holmes books in Chapter 13, there will be a lot of people who want to search for a movie but can't remember much more than a few details. Often you can't remember much more than some movie that had "something about Italians" or "a title with the word Green in it".

The first step is to define an analyzer, inside which we choose which tokenizers to use to split up the text, and which filters to use to modify it.

As we learned previously, an analyzer is a customisable menu of full-text search capabilities that is depends on how you intend to search. We'll go with the `class` tokenizer, which detects changes between digit, letter, punctuation, and blank. After that come the filters ascii (`résumé` to `resume`) and lowercase (`America` to `america`). In Chapter 13 we used the `snowball(english)` filter to turn English words into their root forms, but let's try an `edgengram` this time so that movies will be able to show up as soon as a user starts typing. Using an edgengram will allow movies like "Casino" and "Casablanca" to show up as soon as a user types "cas" (or "CAS", "cAS" and so on, thanks to the `lowercase` filter).

```surql
DEFINE ANALYZER movie_fts TOKENIZERS class FILTERS ascii, lowercase, edgengram(3,10);
```

With that done, we just need to tell SurrealDB to build the index for each field. This is the part that is the most intensive, so it might take a few seconds to complete. As we learned in Chapter 13, adding `BM25` makes it possible to order search results by how well they match, and `HIGHLIGHTS` lets us specify how to highlight parts of text that match so that they stand out. The only difference between the index used for `plot` and `title` is that `title` won't use `HIGHLIGHTS`, as movie titles are never long enough that highlights are needed to point out the matching word.

```surql
DEFINE INDEX plot_index ON TABLE movie FIELDS plot FULLTEXT ANALYZER movie_fts BM25 HIGHLIGHTS;
DEFINE INDEX title_index ON TABLE movie FIELDS title FULLTEXT ANALYZER movie_fts BM25;
```

With the indexes in place, let's practice the matches operator and the search functions again.

First, a query to see what movies have the word "time" in the title or plot.

```surql
SELECT title, plot FROM movie WHERE plot @@ "time" OR title @@ "time";
```

**Response**

```surql
[
  {
    plot: 'April 6th, 1917. As an infantry battalion assembles to wage war deep in enemy territory, two soldiers are assigned to race against time and deliver a message that will stop 1,600 men from walking straight into a deadly trap.',
    title: '1917'
  },
  {
    plot: 'Marty McFly, a 17-year-old high school student, is accidentally sent thirty years into the past in a time-traveling DeLorean invented by his close friend, the eccentric scientist Doc Brown.',
    title: 'Back to the Future'
  },
  {
    plot: 'A mysterious stranger with a harmonica joins forces with a notorious desperado to protect a beautiful widow from a ruthless assassin working for the railroad.',
    title: 'Once Upon a Time in the West'
  },
  {
    plot: 'The Tramp struggles to live in modern industrial society with the help of a young homeless woman.',
    title: 'Modern Times'
  },
  {
    plot: 'A former Prohibition-era Jewish gangster returns to the Lower East Side of Manhattan 35 years later, where he must once again confront the ghosts and regrets of his old life.',
    title: 'Once Upon a Time in America'
  }
]
```

Next, a query using the `search::score()` function to see which three movies have the greatest relation with the search term "time".

```surql
SELECT
    title,
    plot,
    search::score(0) + search::score(1) AS score
FROM movie
    WHERE
        plot @0@ "time" OR title @1@ "time"
ORDER BY score DESC
LIMIT 3;
```

**Response**

```surql
[
  {
    plot: 'The Tramp struggles to live in modern industrial society with the help of a young homeless woman.',
    score: 3.9507575035095215f,
    title: 'Modern Times'
  },
  {
    plot: 'Marty McFly, a 17-year-old high school student, is accidentally sent thirty years into the past in a time-traveling DeLorean invented by his close friend, the eccentric scientist Doc Brown.',
    score: 3.735989570617676f,
    title: 'Back to the Future'
  },
  {
    plot: 'April 6th, 1917. As an infantry battalion assembles to wage war deep in enemy territory, two soldiers are assigned to race against time and deliver a message that will stop 1,600 men from walking straight into a deadly trap.',
    score: 3.4721930027008057f,
    title: '1917'
  }
]
```

That's pretty good. Let's try another query that matches the theme in this chapter: the concept of time. Adding the words present, past, and future should do the trick. Each one of these will return a score, which added together will make up the total relevance score for each movie.

```surql
SELECT
    title,
    plot,
    search::score(0) + search::score(1) + search::score(2) + search::score(3) + search::score(4) + search::score(5) + search::score(6) + search::score(7) AS score
FROM movie
    WHERE
        plot @0@ "time"    OR title @1@ "time"
    OR  plot @2@ "future"  OR title @3@ "future"
    OR  plot @4@ "past"    OR title @5@ "past"
    OR  plot @6@ "present" OR title @7@ "present"
  OR  plot @8@ "fate"    OR title @9@ "fate"
ORDER BY score DESC;
```

Doing so brings the movies Back to the Future and WALL-E straight to the top! Not a bad match for the themes of this book.

```surql
[
  {
    plot: 'Marty McFly, a 17-year-old high school student, is accidentally sent thirty years into the past in a time-traveling DeLorean invented by his close friend, the eccentric scientist Doc Brown.',
    score: 11.41375184059143f,
    title: 'Back to the Future'
  },
  {
    plot: 'A family heads to an isolated hotel for the winter where a sinister presence influences the father into violence, while his psychic son sees horrific forebodings from both past and future.',
    score: 6.268502235412598f,
    title: 'The Shining'
  },
  {
    plot: 'The Tramp struggles to live in modern industrial society with the help of a young homeless woman.',
    score: 3.9507575035095215f,
    title: 'Modern Times'
  },
  {
    plot: "In the future, a sadistic gang leader is imprisoned and volunteers for a conduct-aversion experiment, but it doesn't go as planned.",
    score: 3.702232599258423f,
    title: 'A Clockwork Orange'
  },
  {
    plot: 'In the distant future, a small waste-collecting robot inadvertently embarks on a space journey that will ultimately decide the fate of mankind.',
    score: 3.545522689819336f,
    title: 'WALL·E'
  },
  {
    plot: 'April 6th, 1917. As an infantry battalion assembles to wage war deep in enemy territory, two soldiers are assigned to race against time and deliver a message that will stop 1,600 men from walking straight into a deadly trap.',
    score: 3.4721930027008057f,
    title: '1917'
  },
  {
    plot: 'A mysterious stranger with a harmonica joins forces with a notorious desperado to protect a beautiful widow from a ruthless assassin working for the railroad.',
    score: 3.166771173477173f,
    title: 'Once Upon a Time in the West'
  },
  {
    plot: 'A former Prohibition-era Jewish gangster returns to the Lower East Side of Manhattan 35 years later, where he must once again confront the ghosts and regrets of his old life.',
    score: 3.0653889179229736f,
    title: 'Once Upon a Time in America'
  },
  {
    plot: 'A thief who steals corporate secrets through the use of dream-sharing technology is given the inverse task of planting an idea into the mind of a C.E.O., but his tragic past may doom the project and his team to disaster.',
    score: 3.0321388244628906f,
    title: 'Inception'
  },
  {
    plot: "When a ronin requesting seppuku at a feudal lord's palace is told of the brutal suicide of another ronin who previously visited, he reveals how their pasts are intertwined - and in doing so challenges the clan's integrity.",
    score: 2.957204580307007f,
    title: 'Hara-Kiri'
  },
  {
    plot: "A human soldier is sent from 2029 to 1984 to stop an almost indestructible cyborg killing machine, sent from the same year, which has been programmed to execute a young woman whose unborn son is the key to humanity's future salvation",
    score: 2.9160244464874268f,
    title: 'The Terminator'
  }
]
```

Finally, we'll try out a query to practice the `search::highlight()` function. This function is especially useful when using our edgengram filter, as it will return results even if just the first two letters match. Without highlighting where the match occurred, the reader will probably have a hard time telling exactly which word inside the plot was the matching one.

Adding an asterisk to the left and right side of the matching word will make it most clear which one fits what the user was searching for.

```surql
SELECT
    search::highlight("**", "**", 0) AS plot
FROM movie
    WHERE
        plot @0@ "sl"
LIMIT 4;
```

As two asterisks are often used to make font bold, you can see just how clear this would be for a user who is beginning to type a word in a search for a matching plot.

```surql
[
  {
    plot: 'As corruption grows in 1950s Los Angeles, three policemen - one strait-laced, one brutal, and one **sleazy** - investigate a series of murders with their own brand of justice.'
  },
  {
    plot: 'A former Roman General sets out to exact vengeance against the corrupt emperor who murdered his family and sent him into **slavery**.'
  },
  {
    plot: "In the **slums** of Rio, two kids' paths diverge as one struggles to become a photographer and the other a kingpin."
  },
  {
    plot: "A teacher lives a lonely life, all the while struggling over his son's custody. His life **slowly** gets better as he finds love and receives good news from his son, but his new luck is about to be brutally shattered by an innocent littl"
  }
]
```

The "Officer Ripley awakens from hyper-**sleep**" part is particularly interesting. Thanks to the `class` tokenizer, the original "hyper-sleep" has turned into "hyper" and "sleep" here, allowing a match on "sleep" via a search for "sl" without needing "hyper" to precede it.

In a language like German there are a lot more combined and extremely long words ("Hyperschlaf", or "Donaudampfschiffahrtsgesellschaftskapitän"), in which case an `ngram` of a mid-sized length such as `ngram(4,7)` might be a better option.

Here is a sample of what the output would look like if we also had a German movie called "Donaudampfschiffahrtsgesellschaftskapitän". A search for "DAMPF" alone would do the job if we used an `ngram(4,7)` filter.

```surql
SELECT
  title,
  plot,
  genres
FROM movie
WHERE plot @@ "DAMPF";
```

```surql
[
  {
    genres: [
      'Adventure',
      'Comedy',
      'Fantasy'
    ],
    plot: 'Donaudampfschiffahrtsgesellschaftskapitän bezeichnet als Eigennamenkompositum (und damit unberührt von der Rechtschreibreform) inoffiziell einen Kapitän der von 1829 bis 1991 existierenden Ersten Donau-Dampfschiffahrts-Gesellschaft (DDSG).',
    title: 'Donaudampfschiffahrtsgesellschaftskapitän'
  }
]
```

But for our English movie database, edgengram seems to do the best job so we will stick with it.

That should be enough for this chapter.

And now...do we dare check in on Aeon and Landevin again to see how they are doing?

## A farewell to civilisation

> *You held a group phone call to inform the world's governments that your database would be unavailable for half a day for some "major improvements". They were most unhappy with that and started saying something. You hung up at that point, but can imagine what they were going to say. Probably the same old threat about getting the government in Toria to replace you and give them full access to the tunnel and your database. No matter. No one will be able to get through the closed security door, and they will be too busy with other matters once they realise the database is gone.*

> *You do feel sorry for what has happened, but it's too late now. And it's their fault anyway. Why did they spend a hundred times the effort looking for data on weaponry than subjects like the works of Plato? Oh, the actual queries were about bland subjects like chemicals and aerodynamics, but anyone could see what they were really after.*

> *Inside the control room, you set the security door to close for the maximum duration - one "age" - and chuckle bitterly as you remember that day 45 years ago when you thought you would never need to use it. A door that locks for a few centuries, but no longer - just enough time for everything to be forgotten once the next age arrives. The ancients certainly chose the name well. Perhaps the people of another age will find this place again once the door reopens and do a better job next time. But for now, you and your team have a plane to catch.*

![Two people wearing backpacks, one with a holdall at their feet, standing beside the boarding stairs of a small white private jet on a runway at dusk.](/assets/static/part-19-plane-boarding.BkKrEjnL.avif)

Sigh. Looks like it's time to be patient until somebody finds the door again. In the meantime, [here is the movie dataset](https://datasets.surrealdb.com/learn/book/book-part-19-movies.surql) that we have built so far over the past two chapters that you can experiment with to help pass the time over the next few centuries.
