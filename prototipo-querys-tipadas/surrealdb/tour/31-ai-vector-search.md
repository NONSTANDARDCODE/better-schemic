# 31: AI vector search

AI vector search is used everywhere these days. Since SurrealDB has vector search built in, it's easy to explain the basics in a single page.

Vector search is done using embeddings, which are extremely long arrays of floats that represent the semantic (meaningful) space occupied by a string. You can get these arrays by sending in strings to services like OpenAI and Mistral. This is the main way that these companies make money, by coming up with models that represent a string's "semantic space", which people are willing to pay for.

For example, the following is the result for "A Tale of Two Cities by Charles Dickens" if you send it in to Mistral's embedded model.

```surql
// And so on for a total of 1024 floats
[-0.032562256, 0.026626587, 0.02494812, -0.008369446, 0.010574341]
```

The more the number of floats in the array, the more precise it is. That also means that for a short demonstration, you can usually cut down the length of the array and the precision of the float and still get a pretty good result. Let's do that with the eight books in our library. We'll also use `DEFINE PARAM` to put them inside a database-wide parameter.

```surql
DEFINE PARAM $BOOKS VALUE [
  {
    book:"A Tale of Two Cities by Charles Dickens",
    embeddings:[-0.0326,0.0266,0.0249,-0.0084,0.0106,0.0031,0.0465,-0.0363,0.0112,-0.006,-0.0438,0.0508,-0.0089,-0.0109,-0.0411,0.0052,0.0453,0.0313,0.0175,0.0376,-0.0159,-0.0059,-0.0383,-0.0129,0.0091,0.0078,-0.0228,-0.0578,-0.0115,0.0298,-0.0007,0.0017,0.0061,-0.0303,0.0089,-0.0307,-0.0336,-0.0151,0.059,-0.0087,-0.0215,0.0435,-0.0268,0.0064,0.017,-0.0127,0.0058,-0.0329,-0.0006,-0.0207,-0.0008,0.0459,0.0002,0.0138,-0.0062,0.0172,0.0048,0.0036,-0.0205,0.017,-0.0639,0.0024,-0.0356,0.0313]
  },
  {
    book:"The Little Prince by Antoine de Saint-Exupéry", 
    embeddings:[-0.0148,0.0188,0.0456,-0.0176,-0.0014,0.0279,0.0601,-0.0008,-0.0105,-0.0296,-0.041,0.0459,-0.029,-0.0057,-0.0309,0.0228,0.0215,0.014,0.0137,0.0177,-0.0194,-0.0144,-0.0476,0.0144,-0.0214,0.0059,-0.0279,-0.0476,-0.0212,0.0151,0.0017,0.0063,0.024,-0.0126,0.0297,0.0076,-0.0192,-0.0115,0.0236,-0.0064,-0.0079,-0.0349,0.0122,0.0058,0.0057,-0.0055,-0.014,-0.0179,-0.0035,-0.0112,0,0.0557,0.0131,-0.0209,0.0017,-0.0088,0.0334,0.0158,-0.0584,0.0258,-0.075,0.0202,-0.0097,0.0033]
  },
  {
    book:"The Alchemist by Paulo Coelho", 
    embeddings:[-0.0376,0.044,0.0333,-0.0321,-0.0036,-0.0024,0.0384,-0.0213,0.0068,-0.0205,-0.022,0.0616,-0.0657,-0.0381,-0.0414,-0.0016,0.0204,0.0253,-0.0171,0.0132,-0.0607,0,-0.0518,0.0157,-0.0083,0.0073,-0.019,-0.0238,0.0015,-0.0115,-0.0095,-0.0079,-0.001,0.0065,0.0235,0.0137,-0.0054,-0.012,0.0476,-0.0161,-0.0161,-0.0064,-0.0201,0.0055,-0.0116,0.0199,0.0094,-0.0393,-0.0008,-0.0094,-0.0149,0.0072,0.0089,0.0127,-0.0055,-0.0087,0.0376,0.0047,-0.0512,0.0044,-0.0449,0.007,-0.0222,0.0127]},
  {
    book:"Harry Potter and the Philosopher's Stone by J.K. Rowling",
    embeddings:[-0.0227,0.0235,0.0562,-0.0215,-0.0306,0.0275,0.0451,0.0095,0.0072,-0.0302,-0.024,0.0445,-0.0482,0.0005,-0.0181,0.0075,-0.0045,0.0533,0.0242,0.0243,-0.0313,-0.0226,-0.0232,0.0145,0.0333,0.0222,-0.0112,-0.0638,-0.0304,0.0385,-0.017,0.0202,-0.0024,-0.0145,0.0032,-0.0275,-0.003,-0.0149,0.0341,-0.0496,-0.008,-0.0041,-0.0006,0.0063,0.0092,-0.0665,0.007,-0.0282,-0.0135,-0.0129,0.0266,0.0352,0.0197,0.0146,-0.0118,0.0156,0.0179,0.0049,-0.054,0.0182,-0.0333,-0.0128,-0.0203,0.0123]
  },
  {
    book:"And Then There Were None by Agatha Christie",
    embeddings:[-0.0372,0.0276,0.0775,-0.0109,-0.0149,0.0351,0.0406,-0.0209,-0.0012,-0.0555,-0.0156,0.0562,-0.0348,0.0001,-0.0314,0.0428,0.0059,0.0343,0.0408,0.0104,-0.0201,0.0108,-0.0531,0.0111,-0.0233,-0.0159,-0.0446,-0.0798,-0.0298,0.0223,0.0194,-0.0257,0.0046,0.0223,0.0182,0,-0.0317,0.0177,0.0406,-0.0391,-0.0135,0.0103,-0.0026,0.0305,-0.0057,-0.0118,-0.0329,-0.0706,0.0129,-0.0189,-0.009,0.0607,0.0147,0.0161,-0.0061,0.0245,0.0107,0.0177,-0.0658,0.0072,-0.0583,0.0349,-0.0016,0.0255]
  },
  {
    book:"Dream of the Red Chamber by Cao Xueqin",
    embeddings:[-0.0482,0.0243,0.0211,0.0091,0.0265,0.0193,0.0223,-0.0068,-0.0208,-0.0311,-0.0173,0.0312,-0.0255,-0.0095,-0.0282,0.0235,0.019,0.0149,-0.0049,0.0074,-0.0115,-0.0107,-0.0407,0.0124,-0.0149,-0.015,-0.0339,-0.0419,0,-0.0017,-0.0011,-0.0039,0.0095,-0.005,0.016,-0.0419,-0.0288,-0.0186,0.0525,0.0026,0.0025,-0.0023,-0.0385,0.0143,0.0207,0.0037,0.0054,-0.0309,0.0137,-0.0354,-0.0309,0.0271,-0.0054,-0.0249,-0.0167,0.0115,0.015,-0.0199,-0.0687,0.0413,-0.0682,0.0028,-0.0479,0.0522]
  },
  {
    book:"The Hobbit by J.R.R. Tolkien",
    embeddings:[-0.0291,0.0388,0.0478,-0.0245,-0.0204,0.0312,0.0406,0.0102,-0.0078,-0.0275,-0.032,0.0575,-0.0058,-0.0049,-0.0279,0.0029,0.0213,0.02,-0.0009,0.0188,-0.0206,-0.0135,-0.0495,0.0038,0.0082,0.0143,-0.0163,-0.0388,-0.0156,0.039,-0.0135,0.0055,0.0234,0.009,0.0057,-0.0404,-0.0048,0.0123,0.0238,-0.0036,-0.0138,0.0013,-0.0025,0.0065,0.017,-0.037,0,-0.0425,0.0008,-0.0277,-0.0187,0.0271,0.0258,0.0016,-0.0247,-0.0036,0.0184,0.0175,-0.0339,0.0138,-0.0287,-0.0034,-0.0173,0.0124]
  },
  {
    book:"Alice's Adventures in Wonderland by Lewis Carroll",
    embeddings:[0.0117,0.0348,0.0265,-0.0357,-0.0013,-0.0032,0.0257,0.02,-0.0009,-0.044,-0.0361,0.038,-0.0378,-0.0082,-0.0296,0.0074,0.0327,0.0291,0.034,0.0343,-0.043,-0.0179,-0.0634,-0.0013,-0.0036,0.0343,-0.0014,-0.0466,-0.0269,0.0027,-0.0071,0.0228,-0.001,0.0067,0.0078,-0.0052,-0.0294,-0.0241,0.043,0.007,-0.0149,-0.0048,0.0089,0.0147,0.0126,-0.0078,-0.0034,-0.0252,-0.0119,-0.0163,0.0102,0.0718,0.0041,0.0122,0.0172,0.0043,0.0154,0.0244,-0.0783,0.003,-0.0715,0.0068,-0.0301,0.0459]
  }
];
```

What we want to do now is go through each book to find two books: one that is most similar to it, and one that is the least similar.

To do this, we can use a vector function. There are a lot of vector functions to choose from that give either the similarity or distance, but [vector::cosine()](/docs/reference/query-language/functions/database-functions/vector#vectorsimilaritycosine) is probably the most used. The [vector reference page](/docs/learn/data-models/vector-search/similarity-search) has a convenient diagram showing visually how each type of vector search finds the distance between two embeddings.

These functions are very straightforward, as they just take two arrays of numbers that it uses to calculate their similarity.

```surql
-- returns 0.15258215962441316f
vector::similarity::cosine([10, 50, 200], [400, 100, 20]);
-- returns 0.5838193816777028f
vector::similarity::cosine([10, 50, 200], [100, 500, 200]);
```

We can use this to calculate the most and least similar books to the books we have in the `$BOOKS` parameter. To do this, we can grab the `$BOOKS` parameter and then call the `.map()` function to do something with each object in the array. We want to pass on the book's title, then the two books that are closest and farthest away.

```surql
$BOOKS.map(|$o| {
  book: $o.book,
  closest: // Some code here,
  farthest: // Some code here
});
```

Getting the least distant match is the easier part. We only need to get the book's title (the `book` field) and its `similarity` as determined by the `vector::similarity::cosine()` function. This `SELECT` will be ordered by `similarity` (ascending order, which is the default ordering), after which we can use `[0]` to grab the first result which will be the least similar book.

```surql
(SELECT 
  book, 
  vector::similarity::cosine($o.embeddings, embeddings) AS similarity 
FROM $BOOKS
ORDER BY similarity)[0]
```

The most similar book can use almost the same query, except we will turn the ordering around with DESC (descending order), and grab the book at index 1. That's because the most similar book to any book will be the same book, which will be at index 0.

```surql
closest: (SELECT 
  book, 
  vector::similarity::cosine($o.embeddings, embeddings) AS similarity 
  FROM $BOOKS 
  ORDER BY similarity DESC)[1],
```

```surql
$BOOKS.map(|$o| {
    book: $o.book,
    closest: (SELECT 
      book, 
      vector::similarity::cosine($o.embeddings, embeddings) AS similarity 
      FROM $BOOKS 
      ORDER BY similarity DESC)[1],
    farthest: (SELECT 
      book, 
      vector::similarity::cosine($o.embeddings, embeddings) AS similarity 
      FROM $BOOKS 
      ORDER BY similarity)[0]
});
```

We can see in the output that the search seems to be working. For example, the fantasy book Alice's Adventures in Wonderland is closest to The Little Prince, but farthest from A Tale of Two Cities. And Harry Potter is closest to The Hobbit, but farthest from Dream of the Red Chamber.

**Output**

```surql
[
	{
		book: 'A Tale of Two Cities by Charles Dickens',
		closest: {
			book: 'Dream of the Red Chamber by Cao Xueqin',
			similarity: 0.7450611068610599f
		},
		farthest: {
			book: 'The Alchemist by Paulo Coelho',
			similarity: 0.6628995337278565f
		}
	},
	{
		book: 'The Little Prince by Antoine de Saint-Exupéry',
		closest: {
			book: "Alice's Adventures in Wonderland by Lewis Carroll",
			similarity: 0.8070083720425385f
		},
		farthest: {
			book: 'A Tale of Two Cities by Charles Dickens',
			similarity: 0.6876066320515288f
		}
	},
	{
		book: 'The Alchemist by Paulo Coelho',
		closest: {
			book: 'The Little Prince by Antoine de Saint-Exupéry',
			similarity: 0.7174984614224219f
		},
		farthest: {
			book: "Harry Potter and the Philosopher's Stone by J.K. Rowling",
			similarity: 0.5987401083534584f
		}
	},
	{
		book: "Harry Potter and the Philosopher's Stone by J.K. Rowling",
		closest: {
			book: 'The Hobbit by J.R.R. Tolkien',
			similarity: 0.8005229332445272f
		},
		farthest: {
			book: 'Dream of the Red Chamber by Cao Xueqin',
			similarity: 0.5361842008058969f
		}
	},
	{
		book: 'And Then There Were None by Agatha Christie',
		closest: {
			book: 'The Little Prince by Antoine de Saint-Exupéry',
			similarity: 0.7943983262255832f
		},
		farthest: {
			book: 'The Alchemist by Paulo Coelho',
			similarity: 0.6779242187632444f
		}
	},
	{
		book: 'Dream of the Red Chamber by Cao Xueqin',
		closest: {
			book: 'A Tale of Two Cities by Charles Dickens',
			similarity: 0.7450611068610599f
		},
		farthest: {
			book: "Harry Potter and the Philosopher's Stone by J.K. Rowling",
			similarity: 0.5361842008058969f
		}
	},
	{
		book: 'The Hobbit by J.R.R. Tolkien',
		closest: {
			book: "Harry Potter and the Philosopher's Stone by J.K. Rowling",
			similarity: 0.8005229332445272f
		},
		farthest: {
			book: 'Dream of the Red Chamber by Cao Xueqin',
			similarity: 0.6658151325352907f
		}
	},
	{
		book: "Alice's Adventures in Wonderland by Lewis Carroll",
		closest: {
			book: 'The Little Prince by Antoine de Saint-Exupéry',
			similarity: 0.8070083720425385f
		},
		farthest: {
			book: 'Dream of the Red Chamber by Cao Xueqin',
			similarity: 0.6516681111180728f
		}
	}
]
```

If you want to try the same query with the full 1024-length embeddings, take a look at [this page](full_embeddings.surql) which has them all. You'll see mostly the same order, especially in very close books like Harry Potter and The Hobbit. But for less obvious similarities or distances, you'll see a different book show up with the longer embeddings.

Those were just the basics, but all the rest of vector search is just a more complex way of doing the same thing: finding the similarities and distances between strings. For much more information on this, including an interesting operator that looks like this: `<|2,COSINE|>`, take a look at the [vector search reference page](/docs/learn/data-models/vector-search/overview).

With that, we are now out of time!

We promised a 30 minute tour, and that's probably about how long it's taken to reach this point - give or take a little depending on your learning style. Let's wrap it up!
