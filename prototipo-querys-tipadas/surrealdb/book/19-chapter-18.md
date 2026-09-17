# Chapter 18: Restoring civilisation

**Time elapsed: 50y**

## Triumph

> *You are in a reflective mood today, one of those moods in which you can't help but think about your life and what you have accomplished.*

> *It has indeed been a long journey. 50 years ago a mere librarian, you are now on the verge of restoring civilisation. Most of the inventions of the past have been recreated, and this part of the world is now somewhere around the mid-1900s in terms of technology. That includes the airplane, the personal computer, the phone...and many types of weaponry that still make you uncomfortable.*

> *After the pleasant celebrations last year, you entered into negotiations with the governments of the world to recreate the internet and let knowledge flow free. They have benefitted all this time from your centralised database, but are feeling its limits. Plus, it is just a matter of time. No country is as advanced as yours, but they are progressing. And if they create the internet themselves, they will certainly dictate the rules in their favour. In order to allow information to stay free, you will have to recreate the internet before they do.*

> *Your thoughts are interrupted by a sudden knock on the door. You set your cup of tea down on your desk and look up. It's Landevin, holding the grey book in his hand. He's back from Europe!*

> *"Aeon, I've solved the formula!"*

> *He finally solved it!*

> *"Congratul-" you begin to say, but stop as you detect the note of fear in his voice. What is the matter?*

## Making a movie database

Well! This is exciting news, but what is Landevin afraid of?

It would be interesting to stick around to listen to the rest of the conversation, but we really must get back to our plan to build something real with SurrealDB. We'll hear some more of their conversation in the middle of the chapter.

It looks like restoring the internet is the current topic. One of the most common uses of the internet is streaming content, and to find it you need a database. To finish up the book, we will put together a project with real movie data and make it as detailed as possible. This project will allow us to practice the techniques and concepts that we have already learned, with only a little bit of new knowledge here and there. Hopefully this will make for an enjoyable and relaxing end to the book.

There are a lot of datasets available on the internet for movies, and they usually come in JSON format. Here is an example of one of the highest rated movies in history in JSON format:

```surql
{
    "Title": "Terminator 2: Judgment Day",
    "Rated": "R",
    "Released": "03 Jul 1991",
    "Runtime": "137 min",
    "Genre": "Action, Sci-Fi",
    "Director": "James Cameron",
    "Writer": "James Cameron, William Wisher",
    "Actors": "Arnold Schwarzenegger, Linda Hamilton, Edward Furlong",
    "Plot": "A cyborg, identical to the one who failed to kill Sarah Connor, must now protect her ten-year-old son John from a more advanced and powerful cyborg.",
    "Language": "English, Spanish",
    "Country": "United States",
    "Awards": "Won 4 Oscars. 36 wins & 33 nominations total",
    "Poster": "https://m.media-amazon.com/images/M/MV5BMGU2NzRmZjUtOGUxYS00ZjdjLWEwZWItY2NlM2JhNjkxNTFmXkEyXkFqcGdeQXVyNjU0OTQ0OTY@._V1_SX300.jpg",
    "Ratings": [
        {
            "Source": "Internet Movie Database",
            "Score": "8.6/10"
        },
        {
            "Source": "Rotten Tomatoes",
            "Score": "93%"
        },
        {
            "Source": "Metacritic",
            "Score": "75/100"
        }
    ],
    "DVD": "13 Feb 2007",
    "BoxOffice": "$205,881,154",
}
```

Since SurrealDB works by default as a document database without schema, it's easy to just use an `INSERT INTO movie []` query with this object inside the square brackets. The output for the record looks pretty close to the original JSON.

```surql
[
  {
    Actors: 'Arnold Schwarzenegger, Linda Hamilton, Edward Furlong',
    Awards: 'Won 4 Oscars. 36 wins & 33 nominations total',
    BoxOffice: '$205,881,154',
    Country: 'United States',
        -- ... and so on ...
  }
]
```

There is [a .surql file here](https://datasets.surrealdb.com/learn/book/book-naive-movies.surql) that inserts all of these movies into the database under the table name `naive_movie`, and which will be present in the upcoming queries.

Also note the `RETURN NONE` at the very end of the `INSERT` statement so that your SurrealDB Studio or console window won't be cluttered up with the output of 150 or so movies.

So now we have a database with a lot of movies in it and a whole bunch of data. Is that the end of the project?

Well, no. Inserting the objects as they are is better than nothing, but we end up missing out on a lot of the benefits that SurrealDB offers. Take the following query for example in which we try to return a sorted array of movie runtime length.

```surql
RETURN (SELECT VALUE Runtime FROM naive_movie).sort();
```

The output seems pretty good...

```surql
'102 min',
'102 min',
'102 min',
'103 min',
'103 min',
'103 min',
'105 min',
```

...until we reach this part!

```surql
'229 min',
'68 min',
'81 min',
'87 min',
'87 min',
```

As simple strings, the database can only conclude that '68 min' is greater than '229 min', because 6 is more than 2. And we certainly don't want a dataset that returns results that remind us of that famous Shel Silverstein poem in which the main character has no understanding of how to compare one value with another.

```surql
My dad gave me one dollar bill
'Cause I'm his smartest son,
And I swapped it for two shiny quarters
'Cause two is more than one!
```

But if these fields were durations, the output would be properly ordered in this way instead.

```surql
[
  1h8m,
  1h21m,
  1h27m,
  1h27m,
  1h28m,
  1h28m,
  1h29m,
    -- ... and so on ...
]
```

We will continue to look at and use these `naive_movie` records throughout this final project as we change them when needed to a format that makes querying the data easier and more intuitive.

Let's look at the other `naive_movie` fields and think about how they can be improved.

- `Actors`, `Writer`, `Director`: These fields sometimes have one person, but often more inside a single string, such as `"Arnold Schwarzenegger, Linda Hamilton, Edward Furlong"`. Each of these names should be used to make a separate `person` record, and each `person` should be able to be an actor, writer, director, or all three. With this, we will be able to look up someone like James Cameron and see which movies he wrote, directed, and starred in. So these won't need to be fields on the `movie` table, but standalone records of a different type.

- `Released`: "03 Jul 1991" is readable for humans and maybe we could keep this data in its own field, but we should also turn this into a `datetime` so that we can properly sort movies, see how much time has passed between one director's movie and the next, and so on.

- `Plot`: This looks like a good field to add an index for full text search, as we learned in Chapter 13.

- `Ratings`: This array of objects is a bit tricky because IMDB, Rotten Tomatoes, and Metacritic all use a different format: `8.6/10`, `86%`, and `86/100`. We should find a way to store these as a single integer that ranges between 0 and 100 so that an average rating can be calculated.

- `BoxOffice`: This should be an integer. This will be easy enough once the dollar sign and commas are removed.

- `Awards`: This field is unfortunately not very uniform, with values like `'2 wins'` (wins of what award?), or `'8 wins & 6 nominations'` (why does the movie have more wins than nominations?), and weird formatting like `'Nominated for 1 BAFTA Film Award5 wins & 2 nominations total'`. But some contain the number of Oscars won (`'Won 4 Oscars'`), so we can at least pull this data out and put it into an `oscars_won` field. And we might as well keep `Awards` around as a simple string. It's not the most parsable data, but it's still readable.

The actual records will be created in this sort of fashion:

```surql
FOR $movie IN SELECT * FROM naive_movie {
    CREATE movie SET
        runtime = ,// Modify $data.Runtime to fit our needs
        plot = $movie.Plot, // Will have an analyzer and search index defined so just pass in a string
        rt_rating = ,// Do something with $movie.Ratings to pull out the Rotten Tomatoes score and so on with the others
        // ... and so on ...
}
```

So those are some of the tasks before us. Let's start with something simple, the date "03 Jul 1991". How can we turn this into a datetime?

### Release date, DVD release date

We learned back in Chapter 4 that you can cast into a `datetime` with just a year, month, and day. So all we need to do is turn `"03 Jul 1991"` into `"1991-07-03"`, and put `<datetime>` in front.

```surql
RETURN <datetime>"1991-07-03";
```

**Response**

```surql
'1991-07-31T00:00:00Z'
```

For the sake of readability, it would be nice if we could make this happen on a single line, like this.

```surql
SET
    date = fn::make_into_date($data.Date),
```

So let's put together a quick function or two to make it happen.

The first thing we should do is split the input by whitespace and then return each part so that the format is year-month-day.

```surql
DEFINE FUNCTION fn::date_to_datetime($input: string) -> string {
    LET $split = $input.split(' ');
    RETURN $split[2] + '-' + $split[1] + '-' + $split[0];
};
RETURN fn::date_to_datetime("03 Jul 1991");
```

This will return `'1991-Jul-03'`. Better, but still not good enough to cast into a datetime.

Fortunately, it looks like the dates in this movie data all follow the same format, with months like Jan, Feb, Mar, and so on. To keep our code neat, we can make a separate function that just takes a string and returns another string in numeric format. It requires a good amount of typing, but thanks to SurrealQL's expression-oriented nature, we don't need to use multiple `RETURN` statements in this way:

```surql
    IF $input =      'Jan' { RETURN '01' }
    ELSE IF $input = 'Feb' { RETURN '02' }
    -- ...
```

Instead, we can put a single `RETURN` at the beginning for the entire function.

```surql
RETURN
    IF      $input = 'Jan' { '01' }
    ELSE IF $input = 'Feb' { '02' }
    -- ...
```

At the very end of the long chain of `ELSE IF` checks, we can `THROW` an error along with the input to let the user know what the incorrect input was, and what sort of input is acceptable.

```surql
DEFINE FUNCTION fn::month_to_num($input: string) -> string {
        IF      $input = 'Jan' { '01' }
        ELSE IF $input = 'Feb' { '02' }
        ELSE IF $input = 'Mar' { '03' }
        ELSE IF $input = 'Apr' { '04' }
        ELSE IF $input = 'May' { '05' }
        ELSE IF $input = 'Jun' { '06' }
        ELSE IF $input = 'Jul' { '07' }
        ELSE IF $input = 'Aug' { '08' }
        ELSE IF $input = 'Sep' { '09' }
        ELSE IF $input = 'Oct' { '10' }
        ELSE IF $input = 'Nov' { '11' }
        ELSE IF $input = 'Dec' { '12' }
        ELSE {
            THROW "Invalid input: `" + $input + "`. Please use a three-letter abbreviation such as 'Oct'."
        }
};
```

The two functions together now look like this:

```surql
DEFINE FUNCTION fn::date_to_datetime($input: string) -> datetime {
    LET $split = $input.split(' ');
    RETURN <datetime>($split[2] + '-' + fn::month_to_num($split[1]) + '-' + $split[0]);
};
DEFINE FUNCTION fn::month_to_num($input: string) -> string {
        IF      $input = 'Jan' { '01' }
        ELSE IF $input = 'Feb' { '02' }
        ELSE IF $input = 'Mar' { '03' }
        ELSE IF $input = 'Apr' { '04' }
        ELSE IF $input = 'May' { '05' }
        ELSE IF $input = 'Jun' { '06' }
        ELSE IF $input = 'Jul' { '07' }
        ELSE IF $input = 'Aug' { '08' }
        ELSE IF $input = 'Sep' { '09' }
        ELSE IF $input = 'Oct' { '10' }
        ELSE IF $input = 'Nov' { '11' }
        ELSE IF $input = 'Dec' { '12' }
        ELSE {
            THROW "Invalid input: `" + $input + "`. Please enter an abbreviated three-letter such as 'Oct'."
        }
};
```

With those functions defined, we can now give this a try. Let's pick a single `naive_movie` and try to create a `movie` from it that has a real datetime. We'll then return the movie to see which one it is, and subtract today's date from when it was released to see how old it was.

```surql
LET $one_movie = SELECT * FROM ONLY naive_movie LIMIT 1;
LET $movie_with_datetime = CREATE ONLY movie SET title = $one_movie.Title, released = fn::date_to_datetime($one_movie.Released);
RETURN $movie_with_datetime;
RETURN time::now() - $movie_with_datetime.released;
```

Success! The first RETURN shows the datetime...

```surql
[
  {
    id: movie:zqwscawg135hl7zdnlp8,
    released: '1994-07-06T00:00:00Z',
    title: 'Forrest Gump'
  }
]
```

And the second RETURN shows how many years have passed since the movie was returned. This is much more convenient than working with a string!

```surql
29y47w5d6h26m30s470ms
```

By the time you read this book, it will already be more than 30 years since Forrest Gump was released.

Phew! We're only part of the way through our first task in creating this movie database. Let's take a break for a moment and get back to Aeon and Landevin, who have finally cracked the formula.

## The formula

> *You and Landevin did nothing but read over the formula in silence this afternoon. Again, and again, and again. But the conclusion is inescapable. You finally open your mouth to talk.*

> *"If I'm reading this correctly...we moved too fast?"*

> *Landevin: "Essentially, yes. We worked so hard on restoring the past that we didn't give the people enough time to grow along with it."*

> *You: "So they have modern technology without realising that it can be used for the wrong purposes?"*

> *Landevin: "That's right. They have the tools, but lack the memory. They will soon have the technology to destroy the world but no shared memory of the horror of it. Or they may become addicted to the convenience of technology and forget what it means to be human. Or something else. I'm not sure. The formula doesn't predict what will happen, just that humanity is doomed. It looks like it was about 10 years ago that it passed the tipping point. If only I had only figured out the formula before then..."*

> *You: "But we only passed the tipping point because of the knowledge we restored. And we still hold almost everything inside our database. We hold it, not them. So we could revert it by -"*

> *Landevin: "Yes, we could certainly do that."*

### Ratings

Surely Aeon and Landevin don't mean deleting the entire database after all these years?

Surely not...

Let's pretend we didn't read that and continue with our movie database project. Now where were we...

The data on ratings is a bit more challenging, as it involves turning an object like this into separate fields with each `Score` cast into an integer.

```surql
{
    Source: 'Internet Movie Database',
    Score: '9.3/10'
},
{
    Source: 'Rotten Tomatoes',
    Score: '91%'
},
{
    Source: 'Metacritic',
    Score: '81/100'
}
```

In addition, many `Ratings` objects don't have ratings from all three websites, so we can't guarantee that every movie will have three scores. We will have to take that into account later on when we want to calculate a movie's average score.

Let's play with the data a bit and see what we can discover. First we'll grab the ratings from a single movie.

```surql
LET $data = SELECT VALUE Ratings from naive_movie LIMIT 1;
```

That will be an array with a single item, so let's grab the first one and filter by `Source = 'Internet Movie Database'`.

```surql
LET $data = SELECT VALUE Ratings from naive_movie LIMIT 1;
SELECT Score FROM $data[0] WHERE Source = 'Internet Movie Database';
```

**Response**

```surql
[
  {
    Score: '9.3/10'
  }
]
```

Close, but not quite! We wanted just the number, not an object.

But as we learned back in Chapter 2, we can use `ONLY` along with `LIMIT 1` to let SurrealDB know that we only want to return an object instead of an array of objects, and also add `VALUE` so that we can get just the value instead of the key name plus the value.

```surql
LET $data = SELECT VALUE Ratings FROM ONLY naive_movie LIMIT 1;
SELECT VALUE Score FROM ONLY $data WHERE Source = 'Internet Movie Database' LIMIT 1;
```

This gives us a number like `'9.3/10'`, depending on the movie we got. Turning this into a percentage can now be done by removing the `/10` at the end, casting the remaining string to a `number`, and then multiplying it by 10.

```surql
LET $data = SELECT VALUE Ratings FROM ONLY naive_movie LIMIT 1;
LET $date = SELECT VALUE Score FROM ONLY $data WHERE Source = 'Internet Movie Database' LIMIT 1;
RETURN <number>$date.replace('/10', '') * 10;
```

The output will be a two-digit number.

Finally, we won't always have a string to pass into `.replace()`, because the movie scores that we have sometimes don't have the rating for one or two websites. So we'll want to manually pass back a NONE in this case so that SurrealDB doesn't end up calling `NONE.replace()`, which would generate an error.

Putting all that together, we get three similar functions that each modify their input a little differently. Each of them takes an `array<object>`, pulls out the relevant movie score, checks to see if it is NONE, and returns NONE if so. If it finds data, it will use `string::replace()` instead to modify the string into something that can be cast into a `number`.

We could have gone with a single function, but this is pretty easy to read.

```surql
DEFINE FUNCTION fn::get_imdb($obj: array<object>) -> option<number> {
    LET $data = SELECT VALUE Score FROM ONLY $obj WHERE Source = 'Internet Movie Database' LIMIT 1;
    RETURN IF $data IS NONE { NONE } ELSE { <number>$data.replace('/10', '') * 10 }
};
DEFINE FUNCTION fn::get_rt($obj: array<object>) -> option<number> {
    LET $data = SELECT VALUE Score FROM ONLY $obj WHERE Source = 'Rotten Tomatoes' LIMIT 1;
    RETURN IF $data IS NONE { NONE } ELSE { <number>$data.replace('%', '') }
};
DEFINE FUNCTION fn::get_metacritic($obj: array<object>) -> option<number> {
    LET $data = SELECT VALUE Score FROM ONLY $obj WHERE Source = 'Metacritic' LIMIT 1;
    RETURN IF $data IS NONE { NONE } ELSE { <number>$data.replace('/100', '') }
};
```

### Movie runtimes

Turning the runtime values into durations will not be difficult, as they are all expressed in minutes with the same format:

```surql
Runtime: '133 min'
Runtime: '127 min'
```

The `string::replace()` function will be enough to turn the output from something like '133 min' to '133m', which SurrealDB will be able to cast into a datetime. A change from ` min` to `m` will do the trick.

```surql
LET $one = '133 min';
LET $two = '127 min';
RETURN
    <duration>$one.replace(' min', 'm') -
    <duration>$two.replace(' min', 'm');
```

This will return '6m'.

Now let's give this a try with a single movie from the `naive_movie` records in the database.

```surql
SELECT
    Title,
    <duration>Runtime.replace(' min', 'm') AS runtime
FROM naive_movie
LIMIT 1;
```

**Response**

```surql
[
  {
    Title: 'Django Unchained',
    runtime: 2h45m
  }
]
```

### Genres, languages

Let's move on by taking a look at the data for genre and languages. A quick query returning the languages and genre for three movies shows that this data is less than ideal.

```surql
SELECT Genre, Language FROM naive_movie LIMIT 3;
```

```surql
[
  {
    Genre: 'Drama, Western',
    Language: 'English, German, French, Italian'
  },
  {
    Genre: 'Action, Crime, Drama',
    Language: 'English'
  },
  {
    Genre: 'Drama',
    Language: 'English'
  }
]
```

The language and genre data is just a string - readable for human eyes, but not very useful at all for actual data analysis. Ideally, we would like to be able to use a query that shows us all the languages or genres present in all of our movies.

The first function we would like to use in such a query is one called `array::distinct()` that removes all duplicates. Here is a quick example of its behaviour:

```surql
RETURN [6,7,8,8].distinct();
```

**Response**

```surql
[ 6, 7, 8 ]
```

But this function alone won't do the trick, because it will only check for distinct strings, not individual languages. Let's give this a try with eight movies:

```surql
RETURN (SELECT VALUE Language FROM naive_movie LIMIT 8).distinct();
```

Unfortunately, so many `Language` values are unique strings made up of a combination of languages that `array::distinct()` has hardly filtered anything at all.

```surql
[
  'English, German, French, Italian',
  'English',
  'German, Russian, French, English',
  'English, German, Italian, Japanese',
  'English, Italian, French',
  'Italian, German, English',
  'Italian, English'
]
```

What we really want is to have English, French, German and the rest each treated as a separate data point instead of these big combined strings.

Fortunately, each language is separated by `', '`, making it possible to use the `string::split()` function to turn this into an array. Let's give this a try by creating a `movie` record with just this one `languages` field so we can practice working with the data.

```surql
FOR $movie IN SELECT * FROM naive_movie {
    CREATE movie SET languages = $movie.Language.split(', ')
};
```

Now that each piece of language data is an array of strings instead of a single string, we will be able to do some nicer queries that make use of SurrealDB's array functions, which are quite fun to use one after another inside a single statement.

Let's try to construct a query that returns every language in the database. A `SELECT` query on its own shows a large number of arrays and duplicate information everywhere:

```surql
SELECT VALUE languages FROM movie;
```

**Response**

```surql
[
  [
    'English'
  ],
  [
    'English'
  ],
  [
    'English'
  ],
  [
    'English',
    'Italian',
    'Latin'
  ],
    -- ...
]
```

We can first use the `array::flatten()` function to turn all of these arrays into a single array.

```surql
RETURN (SELECT VALUE languages FROM movie).flatten();
```

**Response**

```surql
[
  'English',
  'English',
  'English',
  'English',
  'Italian',
    -- ...
]
```

There is still a lot of duplicate data though, so let's remove it. A combination of `array::flatten()` followed by `array::distinct()` will do the trick. Or to make the code even shorter, we can use the `array::group()` function which both flattens and removes duplicate values.

```surql
RETURN (SELECT VALUE languages FROM movie).flatten().distinct();
// Same as using .distinct() and then .flatten()
RETURN (SELECT VALUE languages FROM movie).group();
```

**Response**

```surql
[
  'English',
  'Italian',
  'Latin',
  'Spanish',
  'Hindi',
  'German',
    -- ...
]
```

Now that the duplicate data is gone, let's sort it so that people can eyeball the output and easily check if a language is present in the data or not.

```surql
RETURN (SELECT VALUE languages FROM movie).group().sort();
```

**Response**

```surql
[
  'American Sign ',
  'Amharic',
  'Arabic',
  'Belarusian',
  'Cantonese',
  'Czech',
    -- ...
]
```

Finally, let's follow it up with the `array::join()` function to put them all into a single comma-separated string. This function takes an array, followed by a delimiter which we use to tell SurrealDB what to place between each item (a comma, a space, a hyphen, etc.).

```surql
RETURN (SELECT VALUE languages FROM movie).group().sort().join(', ');
```

For all the movies that we have to insert, this query will result in the following output:

```surql
'American Sign , Amharic, Arabic, Belarusian, Cantonese, Czech, Danish, English, Esperanto, French,
Gaelic, German, Greek, Hebrew, Hindi, Hungarian, Italian, Japanese, Korean, Latin, Mandarin, Nepali,
None, Old English, Persian, Polish, Portuguese, Quenya, Russian, Sicilian, Sindarin, Spanish,
Swahili, Turkish, Vietnamese, Xhosa, Yiddish, Zulu'
```

Good work! It looks like we've reached the end of the chapter and still have a lot of work to do. If you are following along with your own running database, be sure to do a quick `DELETE movie` so that these incomplete `movie` records don't get in our way as we continue to experiment with changing the original movie data into something better.

You can see the current state of the database [at this link](https://datasets.surrealdb.com/learn/book/book-part-18-movies.surql), which contains the `naive_movie` inserts along with the functions and the `movie` fields that we have managed to turn into something better than just simple JSON.

And while we are at it, let's get back to Aeon and Landevin and see what they have decided to do.

## A farewell to civilisation

> *You informed the world's governments that your database would be unavailable for half a day while "major improvements" were made. They were most unhappy, and demanded that you double your efforts to recreate the internet so that no worldwide downtime would take place again.*

> *The duration of the downtime was a lie: not 12 hours, but forever. If you move fast, this should be enough to delete the entire database, shut the security door, and get on the airplane waiting to take you to a place where nobody has ever heard of you. In any case, the world will soon be too busy with other matters to care about where you disappeared to.*

> *Inside the control room, you set the door to close for the maximum duration - one "age" - and chuckle bitterly as you remember that day half a century ago when you thought you would never need to use it. A door that locks for a few centuries, but never longer...just until the next age. The ancients certainly chose the name well. Perhaps the people of another age will find this place again once the door reopens and do a better job next time. But for now, you and your team have a plane to catch.*

![Two people in long coats, carrying a briefcase and a suitcase, standing at the foot of the boarding stairs of a small white private jet on a runway at dusk, with an airfield control tower behind them.](/assets/static/part-18-plane-boarding.rm4YI_tE.avif)

Oh no, Aeon and Landevin deleted everything and closed the door! How are we going to finish our movie database project if there is no more story left in the book to tell?

And what is going to happen to Aeon's world now?

...is the book over?
