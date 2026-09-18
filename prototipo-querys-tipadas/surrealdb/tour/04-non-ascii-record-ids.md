# 4: Non-ASCII record IDs

If you need a record ID that goes beyond basic ASCII, you can put it inside ``` backticks.

```surql
-- French
CREATE ONLY place:`ma_bibliothèque`;
-- Japanese works too
CREATE ONLY place:`良い図書館`;
-- And the ancient Sumerian language...
CREATE ONLY place:`𒂍𒁾𒁀𒀀`;
-- Even emojis!
CREATE ONLY `📚📚`:`🧑‍🎓💪💪💪`;
```

**Response**

```surql
-------- Query 1 --------
{
  id: place:`ma_bibliothèque`
}
-------- Query 2 --------
{
  id: place:`良い図書館`
}
-------- Query 3 --------
{
  id: place:`𒂍𒁾𒁀𒀀`
}
-------- Query 4 --------
{
  id: `📚📚`:`🧑‍🎓💪💪💪`
}
```
