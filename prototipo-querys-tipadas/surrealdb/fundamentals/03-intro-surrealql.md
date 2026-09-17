# Why SurrealQL is SQL-like

For better or worse, SQL appears to have won the war of the query languages...

Which begs the question - what were some of its other competitors?

Well.. in the beginning, there was the COBOL programming language. You might not know this but [CODASYL](https://en.wikipedia.org/wiki/CODASYL), the Committee on Data Systems Languages, later renamed to the [Data Base Task Group](https://en.wikipedia.org/wiki/Data_Base_Task_Group), created the COBOL programming language specifically for data processing for the data systems at the time, which were huge mainframe computers.

I don't know about you, but I'm happy that I don't have to use COBOL. Apparently, even the researchers didn't like it since it quickly became a battle between two declarative query languages QUEL and SEQUEL (Structured English Query Language), later renamed SQL but still often referred to as SEQUEL.

After a bloody battle between QUEL and SEQUEL, the allied forces, led by the American National Standards Institute (ANSI), which created the [ANSI](https://archive.org/details/federalinformati127nati/mode/2up) standard, got together a year later and signed an international treaty with the [International Organization for Standardization (ISO)](https://www.iso.org/standard/16661.html).

The hope was that it would bring peace and stability to databases by standardising SQL as THE way to work with databases.

Fast forward a few decades to today and, as anyone who's done plenty of database migrations will tell you, "standard SQL" is a cruel joke filled with false hopes and pitfalls.

Even when migrating between the most well-known "standard SQL" databases such as MySQL and PostgreSQL, you'll hit a lot of inconsistencies such as:

- Data types: a boolean in MySQL is just an alias for `tinyint`, which is incompatible with PostgreSQL's `boolean` type.

- Different words for the same thing, such as `autoincrement` vs `sequence` (except it's not quite the same thing...)

- Generally huge differences in features such as indexes, functions and more.

Unfortunately, SQL follows the example of the English language, which it's based on. There are standards, but each vendor/country does what they want.

I bet you started out thinking, "English is English", until you met English speakers who seemed like they were making things up just to mess with you!

```surql
"Standard English": How are you?
England: Alright?
US: What's up?
Ireland: What's the Craic?
Australia: How ya goin'?
```

These are all the same thing but they're completely different.

The same applies to SQL. People might tell you that "SQL is SQL", but as we've seen with MySQL and PostgreSQL, beyond the hello world examples of `SELECT * FROM hello_sql`, it quickly becomes very different.

Since each SQL dialect is annoyingly different anyway, why force yourself to pretend to be "standard SQL", when you can take the best ideas from SQL and combine them with the best ideas from other NoSQL query languages?

That is exactly what we've done with SurrealQL. It's SQL-like, in that it's based on the foundation of SQL, `SELECT * FROM hello_surrealql`, but after those hello world examples things quickly become surreal as we integrate the best ideas from the various data models and query languages.

One point worth knowing up front is that SurrealQL is not designed for drop-in use with generic SQL ORMs. While “standard SQL” might not exist in practice, many teams experience SQL through whatever dialect their ORM supports, since ORMs abstract away much of the inconsistency between database vendors.

However, the benefits of SurrealQL are numerous, as you'll see throughout the course. Having an outstanding query language is one of the most consistently positive bits of feedback we hear from our community.

Now that we've cleared up what SQL-like means and the illusion of "standard SQL", we're ready to start learning how our outstanding query language stands out from the rest through building our e-commerce database, Surreal Deal Store.
