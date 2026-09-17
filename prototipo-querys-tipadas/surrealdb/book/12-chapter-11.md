# Chapter 11: A growing map

**Time elapsed: 12y**

> *It didn't take long for this part of the world to become connected again. Each new telegraph tower reduces message travel time, turning journeys that once took half a day into ones that now take only a few minutes. Once distant locations are now starting to feel like part of your own backyard.*

> *It is certainly quite the experience to now be in regular contact with the city of Redmont across the bay. You and its mayor have become quite close, despite never having met in person! It truly is remarkable.*

> *The telegraph service is being used more and more as time goes on. People are even able to request information that your team finds in the database and sends back.*

> *This is usually a good thing. But you did hear one disturbing report lately from Landevin, who had just returned from a trip across the great mountains to the east.*

> *Landevin visited two cities there called Bulton and Edmond's Field that have been at war for years. As Bulton is closer to your telegraph route, its people have been crossing the mountains to use it. Their data requests were pretty bland: information about chemicals and metal and manufacturing and so on. But they used that information to gain an advantage in the war. And what's more, they had been doing this for years already! By the time you found out about it, they had already won.*

> *Hopefully they were the good guys...*

> *What else are people using it for that you are unaware of?*

> *Well, there is no stopping progress now. Speaking of which, it's time to get back to the map service you are putting together to make travel easier for the average citizen.*

## The map service and dataset

In this chapter we can reveal something that you may have already figured out yourself: the town of Toria where Aeon lives is located at the same spot as the city of Victoria, British Columbia in modern-day Canada! The population of the world has dropped by quite a bit since then, and many names have changed. The secret has now been revealed because in this chapter we will be dealing with so many pieces of location data that it is now obvious what part of the world we are looking at.

The world felt like a very large place in the distant past, and the same goes for the people of Aeon's time. Take the distance between Toria and Bulton, known as Victoria and Calgary in our time, as an example. If you ask Google Maps or a similar service how long it takes to walk from one to the other, the answer is about 270 hours. But this is assuming modern day infrastructure such as paved roads and ferries to cross the water. Things are different in Aeon's time. Boats are less common, roads are less developed, the entire Rocky Mountains has to be crossed first, and safety is not guaranteed either. Such a journey could have taken a month or longer.

It's no wonder that cities simply lost contact with each other over the centuries between the present day and Aeon's time.

But as the telegraph system continues to grow, people are becoming aware of locations that they hardly knew anything about before. A message can now be passed from Toria to the town of Revelry at the end of the telegraph line within half an hour. Any news from Bulton only has to cross the mountains and reach Revelry for Aeon to be aware of it.

The most fortunate thing for Aeon's team is that the library inside the tunnel contains information on these locations, including their exact coordinates. So instead of having to come up with a system to measure the coordinates themselves, all they need to do is find out which city matches which city in the past.

As a result, Aeon has been able to put together a basic dataset for all of the locations nearby as well as two of the cities across the mountains. You can see the raw data for the towns inside [this dataset](https://datasets.surrealdb.com/learn/book/book-part-11-town-raw-data.surql) which adds them inside a single INSERT statement. The location data is precise enough, making it easy to put it into the geo functions that we learned in the last chapter. Let's give two of them a try!

```surql
LET $city1 = {
  name: "Edmond's Field",
  old_name: "Edmonton",
  population: 6000,
  location: (-113.602, 53.697)
};
LET $city2 = {
  location: (-122.282, 47.682),
  name: 'Redmont',
  old_name: 'Seattle (Redmond)',
  population: 30000
};
RETURN geo::distance($city1.location, $city2.location);
```

**Response**

```surql
904941.0861035966f
```

This will be a big help, because common people during medieval times generally traveled using something known as an *itinerary*: a set of places that you needed to travel to get from one point to another.

Here is part of one called Liber Addimentorum from the 13th century to give you an idea of what they looked like.

![A medieval itinerary-style map, showing how to get from one destination to another. The map is very simple, often showing just a single line between one city to the next.](/assets/static/part-11-liber-addimentorum.q2BSplp_.avif)

A person with an itinerary in hand would then go to the first destination, ask the locals which road to take to reach the next destination, and so on until the final destination is reached. An itinerary is more of a list of places to go than an actual map. If you are curious about the subject, [check out this video](https://www.youtube.com/watch?v=qvbm84iN7qk&t=203s) which explains the experience for the medieval traveler.

But with the precise location data in Aeon's database, people will now be able to construct their own maps instead. Let's use our knowledge from the last few chapters to do so.

We'll start with a few `DEFINE` statements for the fields of our town records to make sure that the data is as we expect.

```surql
DEFINE FIELD name        ON TABLE town TYPE string;
DEFINE FIELD old_name    ON TABLE town TYPE option<string>;
DEFINE FIELD population  ON TABLE town TYPE option<int>;
DEFINE FIELD location    ON TABLE town TYPE geometry<point>;
DEFINE INDEX unique_town ON TABLE town FIELDS name UNIQUE;
```

Each town will be connected to one or more towns by some sort of route. We can use a `RELATE` statement for this. We'll just call this graph table `to`. Since we know that a `town` will always have a `location`, we can use this to calculate the bearing inside the table `to`.

```surql
DEFINE FIELD bearing ON TABLE to
    VALUE geo::bearing(in.location, out.location);
```

Unlike the other `RELATE` statements we have used so far, it's fine to relate Town 1 to Town 2, followed by Town 2 to Town 1.

```surql
RELATE town:one->to->town:two SET ... // Some route data
RELATE town:two->to->town:one SET ... // More route data
```

This is okay because going from `town:one` to `town:two` isn't necessarily the same as going from `town:two` to `town:one`. You might have a gentle downward slope the whole way, while going back will be all uphill and more tiring. Or maybe `town:two` has stricter border controls than `town:one`, so you might want to add a note about that and how best to bribe the guards to get in. This information won't be needed for the route to `town:one`.

Each `to` relation should be unique though, to make sure that we can't use `RELATE town:one->to->town:two` more than once. We can do this with the `DEFINE INDEX...UNIQUE` technique we learned in Chapter 8, except that it's a bit simpler this time. Instead of needing to create a separate `key` field composed of the sorted `in` and `out` fields, we can just define the index on the `in` and `out` fields together. This will make a single index composed of the two fields.

```surql
DEFINE INDEX unique_key ON TABLE to FIELDS in, out UNIQUE;
```

With this index set up, we can relate one town to another via `to`, and from the other direction from the second town to the first, but no more.

```surql
DEFINE INDEX unique_key ON TABLE to FIELDS in, out UNIQUE;
RELATE town:one->to->town:two;
RELATE town:two->to->town:one;
RELATE town:one->to->town:two;
RELATE town:two->to->town:one;
```

**Response**

```surql
-------- Query --------
[
  {
    id: to:12ym9nxe64xjh9kxixl0,
    in: town:one,
    out: town:two
  }
]
-------- Query --------
[
  {
    id: to:x9i854iofrzc8uomb4x0,
    in: town:two,
    out: town:one
  }
]
-------- Query --------
'Database index `unique_key` already contains [town:one, town:two],
with record `to:12ym9nxe64xjh9kxixl0`'
-------- Query 5 --------
'Database index `unique_key` already contains [town:two, town:one],
with record `to:x9i854iofrzc8uomb4x0`'
```

Next, we should add some fields to the `to` table to describe the route. Aeon and the team have the exact location data for these towns, but no precise information on what the routes are like connecting them. As a result, their only choice is to send messages to these locations to ask how the road is to the next location. Questions like "How straight is it?" and "Is there a road? Is it by land, or over water?" are as precise as things can get at this point.

## Literal types

To represent the state of a route from one destination to another, we'll make a few `string` fields that have to be of a certain value. The options we will allow are as follows:

- A route can be: "straight", "crooked", or "very crooked".

- Terrain can be: "road", "normal" (not a road, but not too hard), "hard", and finally "water".

- Slope will be of four types: "flat", "up", "down", and "steep". We don't need "steep up" and "steep down", because a very steep slope is difficult to travel to matter whether you are going up or down it. A steep slope is no fun no matter which direction you are going.

So if a local from The Naimo tells Aeon that "Yep, there's a real nice straight road going to The Hill, no complaints", it can be turned into this object that can be used to make a `to` graph table.

```surql
{
  from: "The Naimo",
  to: "The Hill",
  crookedness: "straight",
  terrain: "road",
  slope: "flat"
}
```

And if another local from Black Bay complains about all the islands that get in the way when crossing the sea to Gaston, then this object can be used to represent the trip.

```surql
{
  from: "Black Bay",
  to: "Gaston",
  crookedness: "crooked",
  terrain: "water",
  slope: "flat"
}
```

One way we could define these fields is by adding an assertion that the `$value` of the field is contained within a number of values that we have decided are valid. The definitions in this case would look like this:

```surql
DEFINE FIELD crookedness ON TABLE to TYPE string
    ASSERT ["straight", "crooked", "very crooked"] CONTAINS $value;
DEFINE FIELD terrain ON TABLE to TYPE string
    ASSERT ["road", "normal", "hard", "water"] CONTAINS $value;
DEFINE FIELD slope ON TABLE to TYPE string
    ASSERT ["flat", "up", "down", "steep"] CONTAINS $value;
```

But there is another type that we can use that is a bit simpler: the literal type that we first used in chapters 5 to 8. In those chapters we defined a literal on a single field, but a literal can be used in regular queries as well. For example, you can even make a literal of type `"Aeon"`! It can have the value "Aeon", nothing else.

```surql
LET $aeon: "Aeon" = "Aeon";
LET $aeon: "Aeon" = "Aeon!";
```

The first query will work, but the second doesn't quite match, so SurrealDB will return an error.

```surql
"Tried to set `$aeon`, but couldn't coerce value:
Expected `'Aeon'` but found `'Aeon!'`"
```

We can put a `|` between all possible values in the same way that we did with our previous schema too.

```surql
LET $database_expert: "Aeon" | "Landevin" = "Landevin";
```

A literal can include type names too (`string`, `number`, `duration`, etc.), as well as arrays and objects. This next literal can be one of three things:

- a string equal to "Uninhabited",

- an object with a `type` field equal to "city" and a `population` that is an integer,

- an object with a `type` field equal to "town" and a `population` that is an integer.

```surql
LET $place:
  "Uninhabited"
  | { type: "town", population: int }
  | { type: "city", population: int }
= { type: "town", population: 3150 };
```

A literal is pretty similar to an enum or a union in a lot of programming languages.

Our literal types for the table `to` will be pretty simple, just a list of possible string values. All together they look like this.

```surql
DEFINE FIELD crookedness ON TABLE to 
   TYPE "straight" | "crooked" | "very crooked";
DEFINE FIELD terrain     ON TABLE to 
   TYPE "road"     | "normal"  | "hard"          | "water";
DEFINE FIELD slope       ON TABLE to 
   TYPE "flat"     | "up"      | "down"          | "steep";
```

## Entering the data

With our first definitions done, let's get to the [raw town data](https://datasets.surrealdb.com/learn/book/book-part-11-town-raw-data.surql) and the [raw trip data](https://datasets.surrealdb.com/learn/book/book-part-11-trip-raw-data.surql) compiled by Aeon and the team. We now need to use this raw data together with the fields we have defined.

The town data looks like this:

```surql
[
  { 
    name: "Toria",          
    old_name: "Victoria",                      
    population: 7000,
    ocation: (-123.338, 48.481) 
  },
  { 
    name: "Sukh",           
    old_name: "Sooke",                         
    population: 1200,  
    location: (-123.723, 48.377) 
  },
]
```

And the trip data looks like this.

```surql
[
  { 
    from: "The Naimo",      
    to: "The Hill",       
    crookedness: "straight",     
    terrain: "road",  
    slope: "up"   
  },
  { 
    from: "The Hill",       
    to: "The Naimo",      
    crookedness: "straight",     
    terrain: "road",  
    slope: "down" 
  }
]
```

After inserting the data, we can put them all together by using a `FOR` loop on all of the trips to start a `RELATE` statement. First we will use a `SELECT` along with `ONLY` and `LIMIT 1` to let SurrealDB know to return a single object instead of an array.

```surql
FOR $trip IN [
    // trip objects here...
] {
  LET $begin = (SELECT * FROM ONLY town WHERE name = $trip.from LIMIT 1);
  LET $end =   (SELECT * FROM ONLY town WHERE name = $trip.to LIMIT 1);
}
```

Then we will start the `RELATE` statement:

```surql
RELATE $begin->to->$end
```

And then `SET` some values for convenience.

The first three are pretty straightforward:

```surql
crookedness = $trip.crookedness,
terrain = $trip.terrain,
slope = $trip.slope,
```

Then calculate the distance:

```surql
distance = geo::distance($begin.location, $end.location),
```

Next is something we will call `speed_modifier`. The default speed for a trip will be 1.0, while road conditions can increase this modifier (which is good) or decrease it (which is bad).

To represent this, we can follow a pretty simple `IF ELSE` pattern.

```surql
speed_modifier =
  (IF     crookedness = "straight"     { 1.0 }
  ELSE IF crookedness = "crooked"      { 0.8 }
  ELSE IF crookedness = "very crooked" { 0.5 })
  *
  (IF     slope = "flat"               { 1.0 }
  ELSE IF slope = "up"                 { 0.8 }
  ELSE IF slope = "down"               { 1.2 }
  ELSE IF slope = "steep"              { 0.5 }
  )
  *
  (IF terrain = "road"                 { 1.2 }
  ELSE IF terrain = "normal"           { 1.0 }
  ELSE IF terrain = "hard"             { 0.7 }
  ELSE IF terrain = "water"            { 1.0 }
  )
```

As a result, a person could have a speed modifier of up to 1.44 when travelling on a road on a gentle downward slope (1.2 * 1.2), and as low as 0.175 when travelling on a path that is very crooked, steep, and in difficult terrain (0.5 * 0.5 * 0.7).

Finally, we will add a `days_travel` field. This assumes that people will move at a default of 20 km per day on land. Water is slightly more complicated. It is faster at 100 km per day, but we should assume that an extra day is needed to find a boat in the first place. The speed modifier for water will only involve crookedness, because water can't have a slope. Any other conditions have to do with weather, which can't be put into a database ahead of time.

```surql
days_travel =
  IF $trip.terrain = "water" { 1 +  (distance / 100000) / speed_modifier  }
  ELSE                       {      (distance / 20000)  / speed_modifier  }
```

Putting all of this together gives us [a complete dataset](https://datasets.surrealdb.com/learn/book/book-part-11-mid-geo-dataset.surql) for these few towns. You can copy and paste the dataset into SurrealDB Studio and then take a look at the results for yourself! Let's take a look at the places that you can get to from Toria:

```surql
SELECT
    terrain,
    distance,
    crookedness,
    slope,
    days_travel,
    bearing,
    in.name AS from,
    out.name AS to
    FROM to
    WHERE in.name = 'Toria';
```

**Response**

```surql
[
  {
    bearing: -112.00711670161101f,
    crookedness: 'straight',
    days_travel: 1.84021258451263f,
    distance: 30670.20974187717f,
    from: 'Toria',
    slope: 'flat',
    terrain: 'road',
    to: 'Sukh'
  },
  {
    bearing: 117.39553589330698f,
    crookedness: 'straight',
    days_travel: 1.9529820601422698f,
    distance: 95298.20601422698f,
    from: 'Toria',
    slope: 'flat',
    terrain: 'water',
    to: 'Marysville'
  },
  {
    bearing: -39.94767014691305f,
    crookedness: 'straight',
    days_travel: 1.8040428991166035f,
    distance: 30067.381651943393f,
    from: 'Toria',
    slope: 'flat',
    terrain: 'road',
    to: 'The Hill'
  },
  {
    bearing: -13.622896156189338f,
    crookedness: 'straight',
    days_travel: 1.421191744500681f,
    distance: 23686.529075011353f,
    from: 'Toria',
    slope: 'flat',
    terrain: 'road',
    to: 'Black Bay'
  }
]
```

If you change 'Toria' to 'Gaston' (today's Vancouver), you can see that there are two places to go: one to the town of Abeston to the east, and another across the water.

Wait a second, both of these routes go to the east. What about the route that goes south into the modern-day United States?

```surql
[
  {
    bearing: 111.22813997318887f,
    crookedness: 'straight',
    days_travel: 3.619233451805639f,
    distance: 60320.55753009399f,
    from: 'Gaston',
    slope: 'flat',
    terrain: 'road',
    to: 'Abeston'
  },
  {
    bearing: -160.6283333598338f,
    crookedness: 'crooked',
    days_travel: 1.5559320538648187f,
    distance: 69491.50673310233f,
    from: 'Gaston',
    slope: 'flat',
    terrain: 'water',
    to: 'Black Bay'
  }
]
```

Oops! Looks like we forgot to add Redmont (modern day Seattle). The trip between these two cities is pretty easy and just involves walking south along the coast a bit. People in Aeon's day will have an easy time travelling between the two locations as well.

We could accomplish this in a few ways:

- Modify the dataset, restart the sandbox environment, and paste it back in to run. This is easiest for us at the moment, but for Aeon and the team this would not be ideal because they are using persistent data and don't want to delete records if they don't have to.

- Copy and paste the whole RELATE statement and modify it to include the trip from Gaston to Redmont. This works fine but takes a bit of typing...and we might find later on that we need to add another RELATE statement.

- Define a function to automate the process. Once a function is defined, we will only have to pass in a few parameters and that will be the end of the task.

So let's learn how to do that!

## Defining functions

Not only does SurrealDB come with a large set of functions to pick and choose from, but also lets you define your own. To start defining your own function, just type `DEFINE FUNCTION` and the name of the function, which starts with `fn::`. After this you need to add parentheses to hold the arguments, then braces (curly brackets) to hold the function body, and finally a semicolon to finish the statement.

Putting that all together, a function without any arguments will look like this:

```surql
DEFINE FUNCTION fn::add_trip() {};
```

This function only returns an empty value at the moment, but it still works!

```surql
SELECT * FROM fn::add_trip();
```

**Response**

```surql
[
  NONE
]
```

Our function should take the arguments that we have been using in our objects to construct the `to` tables. Note that even at this point there is some type safety involved, and the function can no longer be called without providing all five arguments.

```surql
DEFINE FUNCTION fn::add_trip($from: string, $to: string, $crookedness: string, $terrain: string, $slope: string) {
};
SELECT * FROM fn::add_trip();
```

**Response**

```surql
"Incorrect arguments for function fn::add_trip(). The function expects 5 arguments."
```

The body of the function is not a challenge, as all we have to do is copy and paste the content we already have and modify a few parameter names. In addition, we can have the function return the relation that was successfully created instead of just returning `NONE`. To do this, we can assign the `RELATE` statement to a parameter, and return a message at the end of the function to let the user know that the new trip has been added.

```surql
DEFINE FUNCTION fn::add_trip($from: string, $to: string, $crookedness: string, $terrain: string, $slope: string) {
LET $begin = (SELECT * FROM ONLY town WHERE name = $from LIMIT 1);
LET $end =   (SELECT * FROM ONLY town WHERE name = $to LIMIT 1);
LET $relation = RELATE $begin->to->$end
    SET
    crookedness = $crookedness,
    terrain = $terrain,
    slope = $slope,
    distance = geo::distance($begin.location, $end.location),
    speed_modifier =
        (IF     crookedness = "straight"     { 1.0 }
        ELSE IF crookedness = "crooked"      { 0.8 }
        ELSE IF crookedness = "very crooked" { 0.5 })
        *
        (IF     slope = "flat"               { 1.0 }
        ELSE IF slope = "up"                 { 0.8 }
        ELSE IF slope = "down"               { 1.2 }
        ELSE IF slope = "steep"              { 0.5 })
        *
        (IF terrain = "road"                 { 1.2 }
        ELSE IF terrain = "normal"           { 1.0 }
        ELSE IF terrain = "hard"             { 0.7 }
        ELSE IF terrain = "water"            { 1.0 }),
  days_travel =
        IF $trip.terrain = "water" { 1 + (distance / 100000) / speed_modifier }
        ELSE                       {      (distance / 20000)  / speed_modifier  };
  RETURN <string>$relation.in.name + " to " + <string>$relation.out.name + " trip created!";
};
```

And now the function will work!

```surql
fn::add_trip("Gaston", "Redmont", "straight", "road", "flat");
```

**Response**

```surql
"['Gaston'] to ['Redmont'] trip created!"
```

Can we make the function a little bit more rigorous though? What if we enter a town that isn't in the database, or put the parameters in the wrong order, or something else?

Indeed we can. One way is to use a keyword called `THROW`, which stops the execution of a query and returns an error instead. Here is a simple example of a dividing function that first checks to see if the second number is zero. SurrealDB already checks to see if a user tries to divide by zero (it returns `NaN`, which stands for "Not a Number"), but by using `THROW` we can make the error message a little more personal.

Since this function returns a value, we can make it extra rigorous by adding `-> number` to instruct SurrealDB that this function must return a number, and nothing else. Adding a return value also improves readability for anyone reading your code, because now you don't need to read through the function to know what value will be returned.

```surql
DEFINE FUNCTION fn::divide($one: number, $two: number) -> number {
    IF $two == 0 {
        THROW "Can't divide by zero, you should know that by now";
    };
    RETURN $one / $two;
};
RETURN fn::divide(100, 0);
RETURN fn::divide(100, 10);
```

The output shows that the first attempt to use `fn::divide` did indeed stop at `THROW`:

**Response**

```surql
"An error occurred: Can't divide by zero, you should know that by now"
10
```

We can now use `THROW` for the `fn::add_trip` function, which will now make four checks along the way to ensure that the parameters are correct. The first two checks are to make sure that both `$crookedness` and `$terrain` are valid input, as there is no reason to continue at this point if they are not. If these two pass, then the function will query for the town at `$begin` and the town at `$end`. It will then check to see if either of the towns do not exist, by using the `count` function to see if the length is zero. If either of these cases is true, then we don't have two towns that can be related, and `THROW` is used again to stop executing the function.

And since the function returns a string, we can add `-> string` as its signature to make its output clear.

```surql
DEFINE FUNCTION fn::add_trip($from: string, $to: string, $crookedness: string, $terrain: string, $slope: string) -> string {
    IF $crookedness NOT IN ["straight", "crooked", "very crooked"] {
    THROW "Third argument is crookedness: straight, crooked, or very crooked";
    };
    IF $terrain NOT IN ["road", "normal", "hard", "water"] {
        THROW "Fourth argument is terrain: road, normal, hard, or water";
    };
    IF $slope NOT IN ["flat", "up", "down", "steep"] {
      THROW "Fifth argument is slope: flat, up, down, or steep";
    };
    LET $begin = (SELECT * FROM ONLY town WHERE name = $from LIMIT 1);
    LET $end =   (SELECT * FROM ONLY town WHERE name = $to LIMIT 1);
    IF count($begin) = 0 {
        THROW "Could not find town " + $from + " in the database"
    };
    IF count($end) = 0 {
        THROW "Could not find town " + $to + " in the database"
    };
    LET $relation = RELATE $begin->to->$end
        SET
        crookedness = $crookedness,
        terrain = $terrain,
        slope = $slope,
        distance = geo::distance($begin.location, $end.location),
        speed_modifier =
            (IF     crookedness = "straight"     { 1.0 }
            ELSE IF crookedness = "crooked"      { 0.8 }
            ELSE IF crookedness = "very crooked" { 0.5 })
            *
            (IF     slope = "flat"               { 1.0 }
            ELSE IF slope = "up"                 { 0.8 }
            ELSE IF slope = "down"               { 1.2 }
            ELSE IF slope = "steep"              { 0.5 })
            *
            (IF terrain = "road"                 { 1.2 }
            ELSE IF terrain = "normal"           { 1.0 }
            ELSE IF terrain = "hard"             { 0.7 }
            ELSE IF terrain = "water"            { 1.0 }),
        days_travel =
            IF $trip.terrain = "water" { 1 + (distance / 100000) * speed_modifier }
            ELSE                       {      distance / 20000  * speed_modifier  };
  RETURN <string>$relation.in.name + " to " + <string>$relation.out.name + " trip created!";
};
```

Some experimenting with the function shows that it is now a lot stricter than before. Here is the output when none of the arguments are correct:

```surql
fn::add_trip("one", "two", "three", "four", "five");
```

**Response**

```surql
'An error occurred: Third argument is crookedness: straight, crooked, or very crooked'
```

And when only one of the arguments is correct:

```surql
fn::add_trip("one", "two", "straight", "four", "five");
```

**Response**

```surql
'An error occurred: Fourth argument is terrain: road, normal, land, or water'
```

Output when one town exists but the other does not:

```surql
CREATE town SET name = "one", location = (-123.338, 48.481);
fn::add_trip("one", "two", "straight", "road", "down");
```

**Response**

```surql
'An error occurred: Could not find town two in the database'
```

And finally a case where we have managed to satisfy the `add_trip` function by adding the second town.

```surql
CREATE town SET name = "one", location = (-123.338, 48.481);
CREATE town SET name = "two", location = (-123.4, 48.5);
fn::add_trip("one", "two", "straight", "road", "down");
fn::add_trip("two", "one", "straight", "road", "up");
SELECT * OMIT id, in, out FROM to WHERE in.name = 'one' OR out.name = 'one';
```

These two made-up towns are just a few hours' distance from each other, though it takes you a bit longer when the slope is uphill.

**Response**

```surql
[
  {
    bearing: -65.16106044294295f,
    crookedness: 'straight',
    days_travel: 0.36243605117221106f,
    distance: 5033.834044058487f,
    slope: 'down',
    speed_modifier: 1.44f,
    terrain: 'road'
  },
  {
    bearing: 114.79251111210614f,
    crookedness: 'straight',
    days_travel: 0.24162403411480737f,
    distance: 5033.834044058487f,
    slope: 'up',
    speed_modifier: 0.96f,
    terrain: 'road'
  }
]
```

If you prefer SurrealDB's literal type style, you could even remove a few `THROW` statements by instead having the function take an object in which the possible values are already defined. In this case, the function will take a single object called `$input` that holds all of the necessary fields and possible values.

```surql
DEFINE FUNCTION OVERWRITE fn::add_trip($input: {
    from: string,
    to: string,
    crookedness: "straight" | "crooked" | "very crooked",
    terrain: "road" | "normal" | "hard" | "water",
    slope: "flat" | "up" | "down" | "steep"
}) -> string {
    LET $begin = (SELECT * FROM ONLY town WHERE name = $input.from LIMIT 1);
    LET $end =   (SELECT * FROM ONLY town WHERE name = $input.to LIMIT 1);
    IF count($begin) = 0 {
        THROW "Could not find town " + $input.from + " in the database"
    };
    IF count($end) = 0 {
        THROW "Could not find town " + $input.to + " in the database"
    };
    LET $relation = RELATE $begin->to->$end
        SET
        crookedness = $input.crookedness,
        terrain = $input.terrain,
        slope = $input.slope,
        distance = geo::distance($begin.location, $end.location),
        speed_modifier =
            (IF     crookedness = "straight"     { 1.0 }
            ELSE IF crookedness = "crooked"      { 0.8 }
            ELSE IF crookedness = "very crooked" { 0.5 })
            *
            (IF     slope = "flat"               { 1.0 }
            ELSE IF slope = "up"                 { 0.8 }
            ELSE IF slope = "down"               { 1.2 }
            ELSE IF slope = "steep"              { 0.5 })
            *
            (IF terrain = "road"                 { 1.2 }
            ELSE IF terrain = "normal"           { 1.0 }
            ELSE IF terrain = "hard"             { 0.7 }
            ELSE IF terrain = "water"            { 1.0 }),
        days_travel =
            IF $trip.terrain = "water" { 1 + (distance / 100000) * speed_modifier }
            ELSE                       {      distance / 20000  * speed_modifier  };
  RETURN <string>$relation.in.name + " to " + <string>$relation.out.name + " trip created!";
};
```

Which input format to choose depends on your preference. With a literal type the possible input is evaluated even before the function is called. On the other hand, the error output is no longer customised. As a rule of thumb, `THROW` is better if you want to choose your own error output while a literal type is better if you prefer showing all the possible values up front - such as for an API for others to use that will only show the function signature. In that case, you don't need to show any of the function's internal code to explain how it should be used.

```surql
fn::add_trip("Hi");
"Expected a 
  { 
  crookedness: 'straight' | 'crooked' | 'very crooked', 
  from: string, slope: 'flat' | 'up' | 'down' | 'steep', 
  terrain: 'road' | 'normal' | 'land' | 'water', 
  to: string 
  }
but found 'Hi'"
```

In any case, with the new towns added, people can now use the information from queries like this that Aeon or the team will put together for them.

```surql
SELECT
  bearing,
  crookedness,
  days_travel,
  distance,
  slope,
  terrain
FROM to
WHERE
  in.name = "The Hill" AND
  out.name = "Toria";
```

The `days_travel` can then help travelers decide how quickly they want to travel. A number like 1.3 for the route from The Hill to Toria means either one hard day's travel, or two leisurely days of travel with camping outside for the one night. The `bearing` and `distance` fields make it easy to make itineraries with better visuals, and other fields can be used to show the difficulty of the route. Here is an example of what one of them might look like, superimposed over the geography of today's Vancouver Island.

![An imaginary conception of a hand-drawn itinerary map showing a route from one city to the next five destinations, superimposed over the geography of modern day southeast Vancouver Island.](/assets/static/part-11-itinerary.DXI0AaAR.avif)

## Using WHERE to filter arrays

This sort of graph query that returns all the names of towns connected to The Hill is quite familiar to us by now.

```surql
SELECT
  ->to->town.name AS next_routes
  FROM town
  WHERE name = 'The Hill';
```

**Response**

```surql
[
  {
    next_routes: [
      'Toria',
      'The Naimo',
      'Honeymoon'
    ]
  }
]
```

We were able to filter using `WHERE` on the towns, but is there a way to filter from the `next_routes` result so that for example only a single town is returned?

Indeed there is. In the same way that we can use `[]` to index an array, we can also use it with a `WHERE` clause to filter them. Here is a quick example:

```surql
RETURN [8,9,0][0];
RETURN [8,9,0][WHERE $this != 9];
```

**Response**

```surql
-------- Query --------
8
-------- Query --------
[
  8,
  0
]
```

You can filter as many times as you want in a single statement, and even split it over multiple lines for better readability.

```surql
RETURN
  [1,2,3,4,5,6,7,8,9,0]
  [WHERE $this != 2]
  [WHERE $this != 4]
  [WHERE $this % 2 = 0];
```

**Response**

```surql
[
  6,
  8,
  0
]
```

If the items in the array have named fields, you can refer to those fields instead of using `$this`:

```surql
RETURN [
  {
    name: 'Toria',
    temperature: 10.0
  },
  {
    name: 'The Hill',
    temperature: 12.5
  }
][WHERE temperature > 10.0];
```

**Response**

```surql
[
  {
    name: 'The Hill',
    temperature: 12
  }
]
```

Typing `$this.temperature` would have worked too.

This can be combined with a graph query to check to see if a planned route is valid and where to go next. The following query would be helpful for a traveler from The Hill who wants to go to Toria, but hasn't decided where to go next.

```surql
SELECT
  ->to->town[WHERE name = 'Toria']
  ->to->town.name
FROM town
WHERE name = 'The Hill';
```

**Response**

```surql
[
  {
    "->to": {
      "->town": {
        "->to": {
          "->town": {
            name: [
              'Marysville',
              'Sukh',
              'Black Bay',
              'The Hill'
            ]
          }
        }
      }
    }
  }
]
```

This can be extended as far as we like. For the traveler looking to go from The Hill all the way to Hope, we can follow the graph relations all the way to the end to make sure that the route exists, as well as to find some information for the traveler at the end. The output is a bit bland because we don't have much info about Hope, but in Aeon's time each town record probably has a lot more information than this.

```surql
SELECT
  ->to->town[WHERE name = 'Toria']
  ->to->town[WHERE name = 'Black Bay']
  ->to->town[WHERE name = 'Gaston']
  ->to->town[WHERE name = 'Abeston']
  ->to->town[WHERE name = 'Hope'].* AS town_info
FROM town
WHERE name = 'The Hill';
```

**Response**

```surql
[
  {
    town_info: [
      {
        id: town:2ewhmu753guo0wodmhp3,
        location: (-121.459, 49.388),
        name: 'Hope',
        old_name: 'Hope',
        population: 50
      }
    ]
  }
]
```

## Getting the shortest path in a recursive query

We learned the basics of recursive queries three chapters ago, and now it's time to give them a second look. The reason why is that recursive queries also include three convenient algorithms for recursive queries that let you display all possible paths, collect all walked paths, and even find the shortest path from one record to another!

To start, let's take a look at the recursive query syntax again to jog our memory. We will begin with a simple recursive query that follows the `->to->town` path twice starting from the town of Toria, and then returns the `name` field from the towns it finds. In this dataset, the ID for Toria is `town:g36e1zorb1ijxqzw2y67` so we can also use that directly.

```surql
-- Use this query to retrieve Toria...
LET $toria = SELECT VALUE id FROM ONLY town
    WHERE name = 'Toria'
    LIMIT 1;
$toria.{2}(->to->town).name;
-- Or just use the Record ID
town:g36e1zorb1ijxqzw2y67.{2}(->to->town).name;
```

The problem with this query is that the `->to` path can go both ways, because if there is a `->to` path from Toria to The Naimo, then there will also be a path from The Naimo to Toria. The output simply shows all the possible places you could be if you followed two paths. That's not very helpful!

```surql
[
  'Gaston',
  'Toria',
  'Toria',
  'Redmont',
  'Toria',
  'Toria',
  'Honeymoon',
  'The Naimo'
]
```

We can fix this by adding `+path` to the recursive part of the query. Let's give that a try.

```surql
LET $toria = SELECT VALUE id FROM ONLY town
  WHERE name = 'Toria'
  LIMIT 1;
$toria.{2+path}(->to->town).name;
```

Not bad! At least now we can see what the actual path is to reach the final destination after two stops.

```surql
[
  [
    'Black Bay',
    'Gaston'
  ],
  [
    'Black Bay',
    'Toria'
  ],
  [
    'Marysville',
    'Toria'
  ],
  [
    'Marysville',
    'Redmont'
  ],
  [
    'Sukh',
    'Toria'
  ],
  [
    'The Hill',
    'Toria'
  ],
  [
    'The Hill',
    'Honeymoon'
  ],
  [
    'The Hill',
    'The Naimo'
  ]
]
```

We can also add `+inclusive` to this if we want to include the original record, the one for Toria. Let's do that.

```surql
LET $toria = SELECT VALUE id FROM ONLY town
    WHERE name = 'Toria'
    LIMIT 1;
$toria.{2+path+inclusive}(->to->town).name;
```

The output is the same as before, except that it's now clear that each of these paths all start at the town of Toria.

```surql
[
  [
    'Toria',
    'Black Bay',
    'Gaston'
  ],
  [
    'Toria',
    'Black Bay',
    'Toria'
  ],
  [
    'Toria',
    'Marysville',
    'Toria'
  ],
  [
    'Toria',
    'Marysville',
    'Redmont'
  ],
  [
    'Toria',
    'Sukh',
    'Toria'
  ],
  [
    'Toria',
    'The Hill',
    'Toria'
  ],
  [
    'Toria',
    'The Hill',
    'Honeymoon'
  ],
  [
    'Toria',
    'The Hill',
    'The Naimo'
  ]
]
```

Now, what people are probably most interested in when using this map service is the shortest path. Fortunately, there is another keyword we can use here called `+shortest=`. The part after the `=` is the record ID that we want to get the shortest path to. It can also be a parameter that is a record ID.

Let's give this a try to see the shortest path from Toria to Edmond's Field, the city located the greatest number of trips away all the way across the mountains.

```surql
LET $toria = SELECT VALUE id FROM ONLY town
    WHERE name = 'Toria'
    LIMIT 1;
LET $ef = SELECT VALUE id FROM ONLY town
    WHERE name = "Edmond's Field"
    LIMIT 1;
-- Query using parameters
$toria.{..+shortest=$ef}(->to->town).name;
-- Same query using direct record IDs
town:g36e1zorb1ijxqzw2y67.{..+shortest=town:lmcvg9prahkr1hptg0ui}(->to->town).name;
```

**Output**

```surql
[
  'Black Bay',
  'Gaston',
  'Abeston',
  'Hope',
  'Merit',
  'Copper Creek',
  'Revelry',
  'Bulton',
  "Edmond's Field"
]
```

There is a third algorithm called `+collect` which collects all the records along the path. We can give this a try with `.{4+collect}` in the recursive part of the query to return all of the possible places you could be after taking four trips from Toria (including trips that go back to Toria, since `->to->` goes in both directions).

```surql
LET $toria = SELECT VALUE id FROM ONLY town WHERE name = 'Toria' LIMIT 1;
$toria.{4+collect}(->to->town).name;
```

You can think of this as a list of places that can be reached within two or three days when starting from Toria.

```surql
[
  'Black Bay',
  'Marysville',
  'Sukh',
  'The Hill',
  'Gaston',
  'Toria',
  'Redmont',
  'Honeymoon',
  'The Naimo',
  'Abeston',
  'Hope'
]
```

We are pretty good at SurrealDB's geo functions and graph queries by now, so it's now time to move on to the next chapter to see what else Aeon and the team have in store. What other quality of life changes are coming to the world?

Practice time

Let's say that the function should be called `fn::set_writer()` and is used to insert an author and the ID of a book that the author has written.

Answer

There are many ways to do this, but two quick casts into a `<record<person>>` and `<record<book>>` inside of a `RELATE` statement is probably the shortest.

```surql
DEFINE FUNCTION fn::set_writer($person: string, $book: string) {
    RELATE (<record<person>>$person)->wrote->(<record<book>>$book);
};
```

An `INSERT RELATION` could be an option too, since it can be written over multiple lines for readability.

```surql
DEFINE FUNCTION fn::set_writer($person: string, $book: string) {
    INSERT RELATION INTO wrote {
        in: <record<person>>$person,
        out: <record<book>>$book
    };
};
```

### 2. How could you improve the error messages given when using the function?

Assuming that we are working with the following schema that requires `wrote` to go from a record `person` to a record `book`:

```surql
DEFINE TABLE wrote TYPE RELATION in person out book;
```

The original messages are fairly good, but could they be improved?

```surql
fn::set_writer("person:one", "blog:two");
-- Query 1 (execution time: 2.510667ms)
'Found blog:two for field `out`, with record `wrote:te9onqg9xnif9625apk4`,
but expected a record<book>'
fn::set_writer("personone", "bookone");
-- Query 1 (execution time: 1.398708ms)
"Expected a record but cannot convert 'personone' into a record"
```

Hint

SurrealDB has a function that lets you check whether a string is a properly formatted Record ID or not.

Answer

Here is one way to do it, with a single error message for each parameter if the input is incorrect:

```surql
DEFINE FUNCTION fn::set_writer($person: string, $book: string) {
    IF "person" NOT IN $person OR !$person.is_record() {
        THROW "First argument must be a person record, such as `person:one`"
    };
    IF "book" NOT IN $book OR !$book.is_record() {
        THROW "Second argument must be a book record, such as `book:one`"
    };
    INSERT RELATION INTO wrote {
        in: <record<person>>$person,
        out: <record<book>>$book
    };
};
```

Here are two examples of the new error output:

```surql
fn::set_writer("personone", "berktwo");
-- Query 1 (execution time: 1.529375ms)
'An error occurred: First argument must be a person record, such as `person:one`'
fn::set_writer("person:one", "berktwo");
-- Query 1 (execution time: 820.291µs)
'An error occurred: Second argument must be a book record, such as `book:one`'
```

You could try making the errors even more precise if you like. For example, you could first return an error message if the `string::is_record()` method fails, and then uses the `record::tb()` to check the table name of the record.

### 3. How would you write a function that takes an array of strings that represent a person and all of the person's direct ancestors and relates them?

Here is an example of the function in action. It should establish that Philip II is the parent of Alexander the Great, that Amyntas III is the parent of Philip II, and so on. To make it simple, we'll assume that all of these people are already in the database but aren't related to each other yet.

```surql
LET $tree = ["Alexander the Great", "Philip II", "Amyntas III", "Arrhidaeus"];
FOR $name IN $tree {
  CREATE person SET name = $name
};
fn::set_ancestry($tree);
```

Hint

SurrealDB has an array function that makes it easy to slide one index at a time down an array.

Answer

The `array::windows()` function can help here. You can pass in the array as well as the number 2 to instruct it to return a sliding window of two items at a time: Alexander to Philip, then Philip to Amyntas, and so on.

```surql
RETURN ["Alexander the Great", "Philip II", "Amyntas III", "Arrhidaeus"].windows(2);
```

**Response**

```surql
[
  [
    'Alexander the Great',
    'Philip II'
  ],
  [
    'Philip II',
    'Amyntas III'
  ],
  [
    'Amyntas III',
    'Arrhidaeus'
  ]
]
```

With this function it's now easy to move from one parent-child pair down the entire list.

```surql
LET $tree = ["Alexander the Great", "Philip II", "Amyntas III", "Arrhidaeus"];
FOR $name IN $tree {
  CREATE person SET name = $name;
};
DEFINE FUNCTION fn::set_ancestry($input: array<string>) {
    FOR $names IN $input.windows(2) {
        LET $person1 = SELECT * FROM ONLY person WHERE name = $names[0] LIMIT 1;
        LET $person2 = SELECT * FROM ONLY person WHERE name = $names[1] LIMIT 1;
        RELATE $person2->parent_of->$person1;
    }
};
fn::set_ancestry($tree);
```

Finally, let's see who the parent of each person is.

```surql
SELECT name, <-parent_of<-person.name as parent_name FROM person;
```

**Response**

```surql
[
  {
    name: 'Alexander the Great',
    parent_name: [
      'Philip II'
    ]
  },
  {
    name: 'Amyntas III',
    parent_name: [
      'Arrhidaeus'
    ]
  },
  {
    name: 'Arrhidaeus',
    parent_name: []
  },
  {
    name: 'Philip II',
    parent_name: [
      'Amyntas III'
    ]
  }
]
```

### 4. You have an array of objects with some bad data and need to quickly filter out the bad data. How can you do it?

The array of objects looks like the data below, in which sometimes age is set to a string that doesn't parse into a number, and sometimes doesn't include a name. How would you filter out everything unless the object has a proper `age` field and a `name`?

```surql
[
  {
    age: 'Ten',
    name: 'Billy'
  },
  {
    age: 15,
    name: 'Barney'
  },
  {
    age: 20,
    name: "Jergon"
  },
  {
    age: 20
  },
  {
    age: 45,
    name: "Johnny"
  }
];
```

Answer

You can use an array filter at the end with two requirements: that `name IS NOT NONE` and that `age.is_number()`.

```surql
RETURN [
  {
    age: 'Ten',
    name: 'Billy'
  },
  {
    age: 15,
    name: 'Barney'
  },
  {
    age: 20,
    name: "Jergon"
  },
  {
    age: 20
  },
  {
    age: 45,
    name: "Johnny"
  }
][WHERE name IS NOT NONE and age.is_number()];
```

**Response**

```surql
[
  {
    age: 15,
    name: 'Barney'
  },
  {
    age: 20,
    name: 'Jergon'
  },
  {
    age: 45,
    name: 'Johnny'
  }
]
```

### 5. What could you define a literal to match an error type defined in someone else's software?

Here is an example of a possible error type in some other programming language that holds some data inside each possible error.

```surql
type Error {
  InvalidRole(string),
  NotAllowed {
    actor: string,
    action: string,
    resource: string
  }
}
```

Answer

A literal could be a good option here. You could define it on a field to match the original code pretty closely, as follows:

```surql
DEFINE FIELD error ON TABLE data TYPE
  { InvalidRole: string } |
  { NotAllowed:
    {
    actor: string,
    action: string,
    resource: string
    }
  };
```

After this, you could use `IF ELSE` statements to see if the first field in the `error` field is `InvalidRole` or `NotAllowed`. Here is a simple check of this type inside a function that takes a single record that holds this `error` data, and creates a separate record to show that the match has worked.

```surql
DEFINE FUNCTION fn::match_error($data: record<data>) {
  IF $data.error.InvalidRole {
    CREATE stuff SET
      it_worked = "It worked! Got an InvalidRole",
      content = $data.error;
  }
  ELSE IF $data.error.NotAllowed {
    CREATE stuff SET
      it_worked = "It worked! Got a NotAllowed",
      content = $data.error;
  } ELSE {
    THROW "Nothing matched!"
  }
};
```

We can follow this up with two sample `data` records...

```surql
CREATE data:one SET error = { InvalidRole: "BadRole" };
CREATE data:two SET error = { NotAllowed: { actor: "Bad actor", action: "Bad action", resource: "Bad resource" } };
```

And then three queries to show that the error handling worked.

```surql
fn::match_error(data:one);
fn::match_error(data:two);
SELECT * FROM stuff;
```

**Response**

```surql
[
  {
    content: {
      InvalidRole: 'BadRole'
    },
    id: stuff:w30i3vvfct7koet1txv1,
    it_worked: 'It worked! Got an InvalidRole'
  },
  {
    content: {
      NotAllowed: {
        action: 'Bad action',
        actor: 'Bad actor',
        resource: 'Bad resource'
      }
    },
    id: stuff:xon52v8zurodv3d5lnit,
    it_worked: 'It worked! Got a NotAllowed'
  }
]
```
