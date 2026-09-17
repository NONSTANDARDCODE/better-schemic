# 22: Graph relations at greater depth

Graph queries can go much longer than a single step. If the path `->likes->person` goes from a `person` record to another `person` record, then the path `->likes->person->likes->person` will go one more step down. The result will be the people that are liked by someone that is liked by another.

Here is a quick example of this from the X-Men franchise, in which the character Wolverine likes Jean Grey, who likes the superhero Cyclops. Here, the `hero:wolverine->likes->hero` path leads to Jean Grey, the person he likes, but the `hero:wolverine->likes->hero->likes->hero` path to Cyclops, who he hates! (Well, *sort of* hates. It's complicated.)

```surql
CREATE hero:wolverine, hero:jean_grey, hero:cyclops;
RELATE hero:wolverine->likes->hero:jean_grey;
RELATE hero:jean_grey->likes->hero:cyclops;
-- returns Jean Grey, whom Wolverine likes
hero:wolverine->likes->hero;
-- returns Cyclops, whom the person that Wolverine likes likes
hero:wolverine->likes->hero->likes->hero;
```

For our `person` records, just repeating `->works_at->place` would make no sense, because libraries don't work at libraries.

**Path that makes no sense**

```surql
person->works_at->place->works_at->place
```

But the arrows can be turned around at the midpoint to form this path instead.

**Path that makes sense**

```surql
person->works_at->place<-works_at<-person
```

This path starts at a person and then follows the `->works_at->place` path to see where the person works. Once it reaches the `place`, it then follows the `<-works_at<-` path to see the people that are employed by the library. Finally, it uses `.name` to access their `name` field.

Queries can be written over multiple lines, so breaking these paths down with comments on each line can be helpful when you come back to read your own code later.

```surql
person               -- Start at a person
  ->works_at->place  -- go to the place where the person works
  <-works_at<-person -- then to the people that work at that place
  .name              -- and get their names
```

The end result: all the people that work at a library that the first person works at.

```surql
SELECT 
    name, 
    ->works_at->place
    <-works_at<-person.name 
    AS team_members
FROM person;
```

**Response**

```surql
[
  {
    name: 'Sara Bellum',
    team_members: [
      'Samm Schwartz',
      'Sara Bellum',
      'Lydia Wyndham'
    ]
  },
  {
    name: 'Lydia Wyndham',
    team_members: [
      'Samm Schwartz',
      'Sara Bellum',
      'Lydia Wyndham'
    ]
  },
  {
    name: 'Samm Schwartz',
    team_members: [
      'Samm Schwartz',
      'Sara Bellum',
      'Lydia Wyndham'
    ]
  }
]
```

Now let's improve the output a bit by having the `team_members` contain every name *except* the name of the current `person`.

Since a graph path returns an array, that lets us use any of SurrealDB's array functions on it. One of them is called [`array::complement()`](/docs/reference/query-language/functions/database-functions/array#arraycomplement) and returns every item in one array minus the items in a second array.

```surql
array::complement(
    ["He", "is", "almost", "always", "on", "time"],
    ["always", "almost"]
);
```

**Response**

```surql
[
  'He',
  'is',
  'on',
  'time'
]
```

We can use that at the `->works_at->place<-works_at<-person` path to return every person's name, minus the current person.

```surql
SELECT 
    name, 
  -- The function takes two arrays, so put `name` inside an array
    array::complement(->works_at->place<-works_at<-person.name, [name])
    AS team_members
FROM person;
```

Now the output shows each person's teammates, without including the person's name as well.

**Response**

```surql
[
  {
    name: 'Lydia Wyndham',
    team_members: [
      'Sara Bellum',
      'Samm Schwartz'
    ]
  },
  {
    name: 'Sara Bellum',
    team_members: [
      'Lydia Wyndham',
      'Samm Schwartz'
    ]
  },
  {
    name: 'Samm Schwartz',
    team_members: [
      'Lydia Wyndham',
      'Sara Bellum'
    ]
  }
]
```
