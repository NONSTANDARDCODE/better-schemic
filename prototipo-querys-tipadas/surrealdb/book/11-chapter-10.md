# Chapter 10: The ancient world reappears

**Time elapsed: 6y**

- *Build a tower with three connected rods on top that bend to form a large number of shapes. Each shape symbolizes a different word.*

- *Give each tower two telescopes: one to look forward, and another to look backward.*

- *Build another tower a few kilometres away that the operators can see through the telescope.*

> *The most frustrating thing for you is that you are aware of the great inventions of the past, but have no idea how to recreate them. Electricity, the airplane, the internet...all of those are beyond your reach. Yes, you have access to a modern network of computers, but you don't know the first thing about how to make your own!*

> *But you do have one recent success that you are most proud of. It's called the Chappe Telegraph, and was invented in a country called France. It doesn't need any electricity, and is surprisingly straightforward. Here is how it works:*

> *All the tower operators have to do is make the same shape as the tower before it every time they see a change. People at the destination then copy the shapes down and use a code book to turn the symbols back into words.*

> *And just like that, it is now possible to communicate from Toria to Black Bay and even as far as The Naimo in just an hour! Your next job is to set up telegraphs on each of the islands across the bay to reach the city of Redmont.*

> *In the meantime, you and many others have become quite used to the measurements of the past and are finding them quite convenient. They are certainly much more precise than your traditional units like "stride" and "thumb" for length, "stone" and "halfweight" for weight, and "period" for time!*

## Geo functions

It looks like the people of Aeon's part of the world will soon be ready to move from medieval maps to something more precise. To make sure we are not left behind when they do, we'll learn about SurrealDB's geo functions in this chapter and the next. These functions are all based on [GeoJSON](https://en.wikipedia.org/w/index.php?title=GeoJSON&oldid=1226030112), which defines a number of shapes that can be used to calculate distance, area, and so on. A GeoJSON object is composed of a `type` for the type of shape it is, and `coordinates` to indicate the points in space to create it. Here is one example:

```surql
{
    type: "LineString",
    coordinates: [
        [30.0, 10.0],
        [10.0, 30.0],
        [40.0, 40.0]
    ]
}
```

SurrealDB's geo functions have pretty simple signatures. Two of them take two points as an argument:

- `geo::distance()`, which calculates the distance in metres between two points.

- `geo::bearing()`, which calculates the direction to travel to reach the next point.

The other two take a `geometry` (a shape).

- `geo::area()`, which calculates the surface area of a shape.

- `geo::centroid()`, which calculates the central point of a shape.

The easiest function to understand and use is `geo::distance()`, so we will start with that. The most important point to remember here is that the order is longitude, latitude (also known as "eastings", "northings"), not latitude, longitude. This is because the GeoJSON spec has defined its inputs in this order.

Longitudes to the east of the [International Reference Meridian](https://en.wikipedia.org/w/index.php?title=IERS_Reference_Meridian&oldid=1215727042) are positive, and longitudes to the west are negative. Latitudes on the north half of the globe are positive, and latitudes to the south are negative. That means that most countries will have numbers that stay either positive or negative, while a few countries that straddle these lines will have numbers that vary from positive to negative. Here they are highlighted in a map of the world:

![A map of the world, showing countries that straddle the zero degree points of latitude and longitude.](/assets/static/part-10-longitude-latitude.CrzO4IOv.avif)

If you search for the location of London for example, and get this output:

```surql
51.5072° N, 0.1276° W
```

It will become a point containing these two numbers in the opposite order: `-0.1276` and `51.5072`. A tuple of two numbers is recognised by SurrealDB as a geographic point. We can prove this by putting these coordinates into the `type::is_geometry()` function.

```surql
-- Returns true
RETURN (-0.1276, 51.5072).is_geometry();
```

Another way to get a location is by right clicking anywhere in Google Maps or OpenStreetMap, which will let you copy the location at that point. Here is another point inside London:

```surql
51.50919990282684, -0.11196686685079893
```

Turn these around and put them inside a tuple, and you have a point! Let's also remove some of the digits at the end during this chapter for readability, because we don't need to be incredibly precise.

```surql
RETURN (-0.1119, 51.5091);
```

You can also construct a `Point` by following the GeoJSON spec, which SurrealDB will return as two numbers.

```surql
RETURN [(-0.1119, 51.5091),
{
    type: "Point",
    coordinates: [
      -0.1119,
      51.5091
    ]
}];
```

**Response**

```surql
[
  (-0.1119, 51.5091),
  (-0.1119, 51.5091)
]
```

Now that we know how to construct a `Point`, let's use this method to see how far the capitals of the Western Roman Empire (Rome) and the Eastern Roman Empire (Constantinople, now Istanbul) were from each other.

Double clicking on these two cities in Google Maps gives us the following points:

```surql
41.8924, 12.9271
40.6899, 28.9505
```

Now we just need to turn them around, put them into tuples, and stick them into the `geo::distance()` function.

```surql
RETURN geo::distance(
    (12.9271, 41.8924),
    (28.9505, 40.6899)
);
```

The output is `1343408.4453224381f` in metres, so about 1,340 kilometres. You can right click and then select Measure Distance inside Google Maps to see that this is indeed the distance between the two cities.

Next is `geo::bearing()`, which couldn't be easier! It also takes two points, so all you need to do is change the word `distance` in the example above to `bearing`.

```surql
RETURN geo::bearing(
    (12.9271, 41.8924),
    (28.9505, 40.6899)
);
```

The output this time is `90.3601045887473f`, showing that Istanbul is almost directly east of Rome.

Now let's use `LET` to create a variable for each point to make our next query to compare the bearing from Rome to Istanbul and from Istanbul to Rome more readable. Interestingly, the bearing from Point A to Point B is not simply the opposite of the bearing from Point B to Point A. This is due to things like the curvature of the Earth and [the formula used to perform the calculation](https://en.wikipedia.org/w/index.php?title=Haversine_formula&oldid=1319615674) that we don't need to learn in this book.

```surql
LET $rome     = (12.9271, 41.8924);
LET $istanbul = (28.9505, 40.6899);
RETURN {
    rome_to_istanbul: geo::bearing($rome, $istanbul),
    istanbul_to_rome: geo::bearing($istanbul, $rome)
};
```

**Response**

```surql
{
  istanbul_to_rome: -79.02669237408216f,
  rome_to_istanbul: 90.36010458874726f
}
```

Now let's get to the other two functions, which take a larger range of inputs than just two points. Instead, they take a `geometry`. A `geometry` is some sort of shape, of which a `Point` is one. Other types of geometries include `LineString` and `Polygon`, and other combinations of these two: `MultiPoint`, `MultiLineString`, `MultiPolygon`, and finally `GeometryCollection` which holds multiple geometries.

The most common type of geometry used after `Point` is `Polygon`, which is what we will use for the next two functions.

The next function we will look at is `geo::area()`, which returns the area of a geometry. This is easiest for us to test if we find a nice rectangular piece of territory that will only need a `Polygon` of four points to approximate. Let's go with the Canadian province of Saskatchewan, which has a nice boring rectangular shape.

![A raised-relief map of Saskatchewan, a Canadian province with a simple rectangular shape.](/assets/static/part-10-saskatchewan.BA1NH26V.avif)

Clicking on its four corners gives us some approximate coordinates that will be good enough to estimate its surface area. Here they are reversed to match the GeoJSON specs:

```surql
-110.0006, 59.9872
-102.0861, 59.9947
-101.3903, 48.9766
-109.9867, 49.0249
```

With these points ready to go, all we need to do is put them into the function! Don't forget to specify the input as a "Polygon", and then just put the coordinates in. Note the double square brackets inside `coordinates` as well for an array of arrays, not just one array. This is because the function can also take complex types like `MultiPolygon`, which requires arrays of arrays.

```surql
RETURN geo::area({
  type: "Polygon",
  coordinates: [[
        [-110.0006, 59.9872],
        [-102.0861, 59.9947],
        [-101.3903, 48.9766],
        [-109.9867, 49.0249]
    ]]
});
```

And the output is...`651898892358.2931f`! This is a pretty close match to Saskatchewan's official surface area of 651,900 km². Its shape is so rectangular that these four points were enough for an almost perfect match.

And now for the exciting part: the geographic centre of Saskatchewan! Where could it be? Finding it couldn't be easier, because once again all we have to do is change the function name.

```surql
RETURN geo::centroid({
  type: "Polygon",
  coordinates: [[
        [-110.0006, 59.9872],
        [-102.0861, 59.9947],
        [-101.3903, 48.9766],
        [-109.9867, 49.0249]
    ]]
});
```

The output of this function is a point.

**Response**

```surql
(-105.86010100139671, 54.42038629153207)
```

If we go to Google Maps again, we can see that [this is indeed the centre](https://maps.app.goo.gl/FdTn8tEYWDYDNSgb7)! There is even a small detour that allows people passing through to stop for a moment and ponder the wonder of being right in the centre of Saskatchewan.

## Geohashes

There are two more functions left to learn, both of which deal with something called a geohash. Geohashes were invented in 2008 in order to turn rectangular spaces of land into short strings of letters and digits.

Let's start with an example to see how geohashes work. We'll go with the Parthenon in the centre of Athens, which has survived for 2500 years and is very likely still standing during Aeon's time as well.

If you right click on the centre of the [Parthenon](https://en.wikipedia.org/wiki/Parthenon) inside Google Maps, you will get a number like this:

```surql
37.97153324769507, 23.726653194839038
```

Now let's turn the numbers around to put them into a point, which we'll pass into the `geo::hash::encode` function.

```surql
RETURN geo::hash::encode((23.726653194839038, 37.97153324769507));
```

This returns the output `swbb5bt0pnff`, which is 12 digits in length. That's a geohash.

Now try changing the last digit in the second number of the point from 7 to 8.

```surql
RETURN geo::hash::encode((23.726653194839038, 37.97153324769508));
```

We get `swbb5bt0pnff`, the same output! This shows that a geohash isn't a cryptographic hash meant to hide input (which we will learn more about in Chapter 15), but just a convenient shorthand.

The longer the geohash, the greater the precision. We can give this a try with the geohash we have and the `geo::hash::decode()` function, which turns a geohash into a point. Look what happens as we make it shorter and shorter:

```surql
RETURN geo::hash::decode('swbb5bt0pnff');
RETURN geo::hash::decode('swbb5bt0pn');
RETURN geo::hash::decode('swbb5bt0');
RETURN geo::hash::decode('swbb5b');
RETURN geo::hash::decode('swbb');
RETURN geo::hash::decode('sw');
RETURN geo::hash::decode('s');
```

As the geohash decreases in size, it represents a larger rectangular area of land and is thus less precise.

**Response**

```surql
(23.726653140038252, 37.97153321094811)
(23.726654648780823, 37.971531450748444)
(23.726520538330078, 37.97158241271973)
(23.7249755859375, 37.97149658203125)
(23.73046875, 38.056640625)
(28.125, 36.5625)
(22.5, 22.5)
```

Here is another way to visualise our geohash that began with a point inside Athens. You can give it a try on [this website](https://geohash.softeng.co/) that lets you start from the world map and go one step at a time into smaller and smaller rectangular areas.

- The first letter 's' is a huge rectangle ranging from western to eastern Europe and down to the west and east side of central Africa.

- This rectangle 's' is divided into further rectangles. One of them is 'w'. Together they make 'sw', which spans a much smaller area: Greece, Turkey, Cyprus, and so on.

- This rectangle is divided into further rectangles, and so on and so forth until you reach `swbb5bt0pnff`.

This handy table will help you decide how many digits you need to store in a geohash for it to be useful.

| Geohash length | Precision |
| --- | --- |
| 1 | 5,009.4km x 4,992.6km |
| 2 | 1,252.3km x 624.1km |
| 3 | 156.5km x 156km |
| 4 | 39.1km x 19.5km |
| 5 | 4.9km x 4.9km |
| 6 | 1.2km x 609.4m |
| 7 | 152.9m x 152.4m |
| 8 | 38.2m x 19m |
| 9 | 4.8m x 4.8m |
| 10 | 1.2m x 59.5cm |
| 11 | 14.9cm x 14.9cm |
| 12 | 3.7cm x 1.9cm |

The Parthenon is about 70 metres across, so a precision of 9 digits or even 8 digits is probably good enough.

## Geometries and operators

One really useful part of a geohash is that it allows you to quickly determine if one location is contained in the same zone as another one.

For example, take these geohashes for four cities in Ireland.

```surql
RETURN [
  // Dublin
    geo::hash::encode((-6.1971555689385, 53.42134668221924)),
  // Limerick
    geo::hash::encode((-8.590306690257298, 52.70463210234539)),
  // Cork
    geo::hash::encode((-8.501730637251514, 51.92118887515803)),
  // Galway
    geo::hash::encode((-9.06855268816339, 53.33052233370851))
];
```

Notice how easy it is to compare the items inside the output?

**Response**

```surql
[
  'gc7xfvp3gucc',
  'gc3gud8dxre0',
  'gc1zqecnz745',
  'gc3x3ss2z3vj'
]
```

A single glance tells you that all of these locations are inside `g`, then inside `c`, and only after then do they differ. And because the precision at the second level (where they all match) is 1,252.3km x 624.1km but the precision at the third level (where none of them match) is 156.5km x 156km, you know immediately that these places are fairly close but still a few hours' drive away from each other.

But be sure to remember that geohashes are only rough estimates, because they refer to rectangular regions. Some locations are located close to each other but across the border, and will seem to be far apart when they may actually be quite close. Take Cambridge and Northampton for example:

```surql
RETURN [
  // Cambridge
    geo::hash::encode((0.12828879218748016, 52.22088932116364)),
  // Northampton
    geo::hash::encode((-0.8910089824568541, 52.26533564501211)),
];
```

The distance between them is a mere 70 km, but one lies inside 'u' and the other inside 'g', because both of them are close to the border of their own geohash.

**Response**

```surql
[
  'u1214ft2tr74',
  'gcr37dx5tuxx'
]
```

So when you see a precision of 5,009.4km x 4,992.6km, remember that this includes very short distances as well! The only guarantee we have from these two geohashes is that Cambridge and Northampton are located in different squares about 5000 km in size, but since `u` and `g` border each other, they might be very close to each other.

A good analogy for this is that both Detroit and San Francisco are in the "zone" of the United States, while Windsor and Vancouver are both in the "zone" of Canada. But it is Detroit and Windsor, and Vancouver and San Francisco that are closest to each other.

If you ever have any doubts, be sure to use the `geo::distance()` function to get the real story.

```surql
RETURN geo::distance(
    geo::hash::decode('u1214ft2tr74'),
    geo::hash::decode('gcr37dx5tuxx')
);
```

As it shows, the distance from Cambridge to Northampton is `69575.20061823408f`, so about 70 km.

SurrealDB's CONTAINS and INSIDE operators also work for geometries. Remember the Canadian province of Saskatchewan? Its capital Regina is located at the following geohash.

```surql
RETURN geo::hash::encode((-104.6268, 50.4620));
```

**Response**

```surql
'c8vx54m46ye7'
```

We can use these operators to check not only whether a point is inside a geometry, but also another geometry.

```surql
LET $saskatchewan = {
  type: "Polygon",
  coordinates: [[
        [-110.0006, 59.9872],
        [-102.0861, 59.9947],
        [-101.3903, 48.9766],
        [-109.9867, 49.0249]
    ]]
};
RETURN geo::hash::decode('c8vx54m46ye7') INSIDE $saskatchewan;
LET $regina = {
  type: "Polygon",
  coordinates: [[
    [-104.7713, 50.5136],
    [-104.5402, 50.5113],
    [-104.5649, 50.3977],
    [-104.7622, 50.3978]
  ]]
};
RETURN $saskatchewan CONTAINS $regina;
```

## Comparing values and complex record ID behaviour

Now that Toria and Redmont are able to communicate across the bay, they can exchange information such as weather conditions.

Let's test this by inserting some `temperature` values for a table called `weather` and then query for records that match the city of Toria along with temperatures between 10 and 20 degrees.

```surql
INSERT INTO weather (at, temperature, date) VALUES
    (city:toria,   15, d"0175-07-01"),
    (city:toria,   18, d"0175-07-02"),
    (city:toria,   16, d"0175-07-03"),
    (city:redmont, 16, d"0175-07-01"),
    (city:redmont, 17, d"0175-07-02");
SELECT * FROM weather WHERE at = city:toria AND temperature IN 10..20;
```

No surprise here! This sort of query is very easy for us by now.

```surql
[
  {
    at: city:toria,
    date: d'0175-07-01T00:00:00Z',
    id: weather:bd5o8142orenkzckql6w,
    temperature: 15
  },
  {
    at: city:toria,
    date: d'0175-07-03T00:00:00Z',
    id: weather:gehp0j94i8c8hx8dnm7y,
    temperature: 16
  },
  {
    at: city:toria,
    date: d'0175-07-02T00:00:00Z',
    id: weather:pa7ldhlnhwfjjpm671em,
    temperature: 18
  }
]
```

But SurrealDB also allows us to do range queries on the `id` field of a record itself, such as all the records from `person:1` to `person:10`. This works on any sort of record ID, including complex ones.

There are four main options when using range syntax in SurrealDB.

- `low..high` for up to but not including a value (an exclusive range). `person:1..person:10` would return everything up to but not including `person:10`.

- Changing `..` to `..=` for up to and including a value (an inclusive range). `person:1..=person:10` would return everything up to as well as `person:10`.

- Changing `..` to `>..` for from but not including a value (an exclusive range). `person:1>..=person:10` would return everything from `person:2` to `person:10`.

- `..` (if not followed by anything) for an unbounded range. `person:1..` would return everything equal to or greater than `person:1`, `..=person:10` would return anything up to and including `person:10`, and so on. And a single `..` creates a range that includes everything.

We'll try this behaviour with three cities: Toria, Redmont, and Black Bay.

```surql
CREATE city:toria, city:redmont, city:black_bay;
// From redmont and up to but not including toria
SELECT * FROM city:redmont..toria;
// From redmont and up to and including toria
SELECT * FROM city:redmont..=toria;
// Everything starting from black_bay
SELECT * FROM city:black_bay..;
```

**Response**

```surql
-------- Query --------
[
  {
    id: city:redmont
  }
]
-------- Query --------
[
  {
    id: city:redmont
  },
  {
    id: city:toria
  }
]
-------- Query --------
[
  {
    id: city:black_bay
  },
  {
    id: city:redmont
  },
  {
    id: city:toria
  }
]
```

That was fairly straightforward, as those simple IDs were in alphabetic order. Now what about more complex IDs? Let's give these a try with some weather data inside an array.

```surql
CREATE weather:[city:toria,   d"0175-07-01"] SET temperature = 19.0, humidity = 55.0;
CREATE weather:[city:toria,   d"0175-07-02"] SET temperature = 15.0, humidity = 40.4;
CREATE weather:[city:toria,   d"0175-07-03"] SET temperature = 21.1, humidity = 77.2;
CREATE weather:[city:redmont, d"0175-01-02"] SET temperature = 18.8, humidity = 65.2;
CREATE weather:[city:redmont, d"0175-07-02"] SET temperature = 18.9, humidity = 55.0;
```

And now we can select all the records between certain cities and dates.

```surql
CREATE weather:[city:toria,   d"0175-07-01"] SET temperature = 19.0, humidity = 55.0;
CREATE weather:[city:toria,   d"0175-07-02"] SET temperature = 15.0, humidity = 40.4;
CREATE weather:[city:toria,   d"0175-07-03"] SET temperature = 21.1, humidity = 77.2;
CREATE weather:[city:redmont, d"0175-01-02"] SET temperature = 18.8, humidity = 65.2;
CREATE weather:[city:redmont, d"0175-07-02"] SET temperature = 18.9, humidity = 55.0;
-- Everything for Toria this year, but no other cities
SELECT * FROM weather:[city:toria, d"0175-01-01"]..=[city:toria, ..];
```

```surql
[
  {
    humidity: 55,
    id: weather:[
      city:toria,
      d'0175-07-01T00:00:00Z'
    ],
    temperature: 19
  },
  {
    humidity: 40.4f,
    id: weather:[
      city:toria,
      d'0175-07-02T00:00:00Z'
    ],
    temperature: 15
  },
  {
    humidity: 77.2f,
    id: weather:[
      city:toria,
      d'0175-07-03T00:00:00Z'
    ],
    temperature: 21.1f
  }
]
```

For the next query, let's try a record range that returns a result that may be surprising. At first glance, it looks like it should return every `weather` record in between `city:redmont` and `city:toria` in the first item, and a date of `d"0175-01-01"` and `d"0175-06-01"` in the second item.

```surql
CREATE weather:[city:toria,   d"0175-07-01"] SET temperature = 19.0, humidity = 55.0;
CREATE weather:[city:toria,   d"0175-07-02"] SET temperature = 15.0, humidity = 40.4;
CREATE weather:[city:toria,   d"0175-07-03"] SET temperature = 21.1, humidity = 77.2;
CREATE weather:[city:redmont, d"0175-01-02"] SET temperature = 18.8, humidity = 65.2;
CREATE weather:[city:redmont, d"0175-07-02"] SET temperature = 18.9, humidity = 55.0;
-- This record range...
SELECT * FROM weather:[city:redmont, d"0175-01-01"]..=[city:toria, d"0175-06-01"];
-- is not the same as this!
SELECT * FROM weather WHERE
    id[0] >= city:redmont AND
    id[0] <= city:toria AND
    id[1] >= d"0175-01-01" AND
    id[1] <= d"0175-06-01";
```

However, the output shows no results that include `city:toria`, and one result that includes a date `d'0175-07-02T00:00:00Z'`, which is one month past June!

**Response**

```surql
[
  {
    humidity: 65.2f,
    id: weather:[
      city:redmont,
      d'0175-01-02T00:00:00Z'
    ],
    temperature: 18.8f
  },
  {
    humidity: 55,
    id: weather:[
      city:redmont,
      d'0175-07-02T00:00:00Z'
    ],
    temperature: 18.9f
  }
]
```

To understand how this works, we will first need to learn how SurrealDB compares values, arrays, and objects with each other.

The first concept to learn is that everything returned from SurrealDB is a value, and any value can be compared with another. We can show this with the following query that returns `true`, instead of an error such as "Cannot compare a string to an int".

```surql
RETURN 'Aeon' > 10;
```

This is because every value internally has an order that goes as follows, from least to greatest:

```surql
none
null
bool
number
string
duration
datetime
uuid
array
set
object
geometry
bytes
table
record
file
regex
range
```

So any string will be greater than any number, null will always be greater than any none, any duration will be greater than any string, and so on. We can show this with the following query that returns `true` for every comparison:

```surql
RETURN [
    null > none,
    true > null,
    1 > true,
    'a' > 999999999,
    1m > 'a',
    time::now() > 1m,
    rand::uuid() > time::now(),
    [ 9, 10 ] > rand::uuid(),
    { 9, 10 } > [ 9, 10 ],
    {} > { 9, 10 },
    (9.9, 9.9) > {},
    <bytes>"Aeon" > (9.9, 9.9),
    type::table("person") > <bytes>"Aeon",
    person:one > type::table("person"),
    f"file://myfile.txt" > person:one,
    <regex>"a|b" > f"file://myfile.txt",
    0..10 > <regex>"a|b",
    || > 0.. 10
];
```

You don't have to remember each of these types and their order, and indeed, there is probably no situation in which you might want to compare a type like `object` with a `string`, to choose a random example.

Let's get back to arrays. With arrays, comparison is done by index. If you compare the following two arrays, the output will be `true` because "Landevin" comes after "Aeon" ("Landevin" is `greater` than "Aeon", at least alphabetically). And since the first item already shows that one is greater than the other, there's no need to look at the rest.

```surql
-- returns true
["Landevin", "Black Bay"] >
["Aeon",     "Toria"    ];
```

If the item in the first index is the same in both, it will continue on to the next item to compare, and so on until it can determine whether one is greater or less than the other. In this next example, it will now conclude that the first array is not greater than the second, because "Black Bay" which begins with B is less than "Toria" which begins with T.

```surql
-- returns false
["Landevin", "Black Bay"] >
["Landevin", "Toria"    ];
```

And this is the same logic that it uses in our record range query above. Instead of being a `WHERE` filter based on the items of the arrays, the query is done on a range of arrays as compared with each other. It returns all records from `city:redmont` because the first item in all of these arrays is between `city:redmont` and `city:toria`, but none of the `city:toria` records because they are all from July, and thus greater than `weather:[city:toria, d"0175-06-01"]`.

```surql
CREATE weather:[city:toria, d"0175-07-01"] SET temperature = 19.0, humidity = 55.0;
CREATE weather:[city:toria, d"0175-07-02"] SET temperature = 15.0, humidity = 40.4;
CREATE weather:[city:toria, d"0175-07-03"] SET temperature = 21.1, humidity = 77.2;
CREATE weather:[city:redmont, d"0175-01-02"] SET temperature = 18.8, humidity = 65.2;
CREATE weather:[city:redmont, d"0175-07-02"] SET temperature = 18.9, humidity = 55.0;
-- This query...
SELECT * FROM weather:[city:redmont, d"0175-01-01"]..=[city:toria, d"0175-06-01"];
-- is the same as this one! (But the first is more optimized)
SELECT * FROM weather WHERE 
  id >= weather:[city:redmont, d"0175-01-01"] AND 
  id <= weather:[city:toria, d"0175-06-01"];
```

**Response**

```surql
-------- Query 1 --------
[
  {
    humidity: 65.2f,
    id: weather:[
      city:redmont,
      d'0175-01-02T00:00:00Z'
    ],
    temperature: 18.8f
  },
  {
    humidity: 55,
    id: weather:[
      city:redmont,
      d'0175-07-02T00:00:00Z'
    ],
    temperature: 18.9f
  }
]
-------- Query --------
[
  {
    humidity: 65.2f,
    id: weather:[
      city:redmont,
      d'0175-01-02T00:00:00Z'
    ],
    temperature: 18.8f
  },
  {
    humidity: 55,
    id: weather:[
      city:redmont,
      d'0175-07-02T00:00:00Z'
    ],
    temperature: 18.9f
  }
]
```

Aeon is going to be busy over the next few years continuing to grow this new network of telegraph towers. In the next chapter, we'll see how the world has changed as a result.

Practice time

Answer

A length of 8 or 9 should do the trick. A length of 8 will result in a maximum length of 38.2 metres before a user is informed about crossing a border, while a length of 9 further refines this to 4.8 metres.

### 2. Where is the approximate geographic centre of Pennsylvania?

Here are some approximate coordinates for the corners of the state to get you started - feel free to add more points if you want a more accurate result!

```surql
[-80.54, 41.97],
[-75.00, 41.70],
[-75.41, 39.78],
[-80.50, 39.72]
```

Answer

You can stick these coordinates into the `geo::centroid()` function as a Polygon. Don't forget the extra set of square brackets! This function can take both a Polygon and a MultiPolygon, so it expects an array of arrays of arrays (not just an array of arrays).

```surql
RETURN geo::centroid({
  type: "Polygon",
  coordinates: [[
  [-80.54, 41.97],
  [-75.00, 41.70],
  [-75.41, 39.78],
  [-80.50, 39.72]
  ]]
});
```

The result is (-77.9292063020214, 40.8094857312723), which looks to be somewhere close to a place called Port Matilda. Even this rough estimate is pretty close to the actual centre of the state.

### 3. How far away is Philadelphia from it?

Answer

Wikipedia gives us the values of 39.9528°N 75.1636°W for Philadelphia's location, which we will need to turn around to make a point at `(-75.1636, 39.9528)`.

After that, we can plug them into the geo::distance() function. Let's also define them as parameters to make the query nice and readable.

```surql
LET $centre = (-77.9292, 40.8094);
LET $philly = (-75.1636, 39.9528);
RETURN geo::distance($centre, $philly);
```

The output is `252863.84609152688f`, so a line about 253 km in length.

### 4. What direction do you have to travel from Philadelphia to get to the centre? And vice versa?

Answer

This can be done by changing the function name in the code above from `distance` to `bearing` and we are done!

```surql
LET $centre = (-77.9292, 40.8094);
LET $philly = (-75.1636, 39.9528);
RETURN geo::bearing($centre, $philly);
RETURN geo::bearing($philly, $centre);
```

The output is approximately 111 degrees one way, and -67 degrees the other.

### 5. You are building a map of bicycle rental stations inside one city. Which length of geohash would you want to use?

Answer

A length of 6 or 7 is a good starting point. Length 6 boxes are on the order of a city block (roughly 1.2 km), and length 7 narrows that further (roughly 150 m).

That should allow your map to easily determine which blocks have the most and least number of rental stations, which will help to get an idea of which parts of the city have enough and which don't have enough bicycle access.
