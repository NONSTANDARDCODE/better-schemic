# 18: FOR loops

Another way to work with the items inside an array is to use a [`FOR`](/docs/reference/query-language/statements/for) loop. After `FOR`, choose a parameter name (like `$item` or `$person`) to be used every time the loop occurs, follow it with `IN` and the data, and then `{}` to open up a space in which you can write custom logic for each item in the loop.

Inside the loop in the next query, the parameter `$person` can be used to set the fields of each `person` record. Since each step of a `FOR` loop is isolated inside its own space, the output of a `FOR` loop will always be empty. To see the results of the `person` records created in this way, we will need to use a `SELECT` statement after the loop is done.

```surql
FOR $person IN [
  {
    age: 30,
    name: 'Sara Bellum'
  },
  {
    age: 25,
    name: 'Lydia Wyndham'
  },
  {
    age: 45,
    name: 'Samm Schwartz'
  }
] {
    CREATE person SET
      age = $person.age,
      name = $person.name
};
SELECT * FROM person;
```

**Response**

```surql
[
  {
    age: 45,
    id: person:cj8wc617o1ea2vs1yv4n,
    name: 'Samm Schwartz'
  },
  {
    age: 30,
    id: person:e8z6pjqhuwzfalbku61n,
    name: 'Sara Bellum'
  },
  {
    age: 25,
    id: person:faovorn8ntkqwfw01638,
    name: 'Lydia Wyndham'
  }
]
```

This is the way that we will create these employees for the library, but we also want to link each one to the library at each step of the `FOR` loop after creating them (so run a quick `DELETE person` at this point if you are following along separately). This time the link will be something called a graph edge, which we will first need to learn to use starting on the next page.
