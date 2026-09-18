# Done the tour!

Well done! You've reached the end of the tour. While thirty-one short pages is only enough to just scratch the surface, you are now familiar with many of the main features that SurrealDB has to offer.

Check out our other offerings to learn more:

- [SurrealDB Fundamentals](/learn/fundamentals), where you'll build a simple ecommerce database, guided through both video and text and get a completion certificate at the end.

- [Aeon's Surreal Renaissance](/learn/book), where you'll immerse yourself in a fantasy book in which you follow the main character in a medieval future that uses SurrealDB to rebuild the world of our 21st century.

And don't forget to drop by any other parts of [our community](https://github.com/surrealdb/surrealdb). The most active part of the community is [Discord](https://discord.com/invite/surrealdb) - a great place to meet others using SurrealDB, share what you're building, get advice, and talk with the team. `#showcase`, `#help`, and `#general` are good places to start.

And finally, here is the entire dataset for this tour - including the queries in the first few chapter for records that eventually got deleted.

Hope you enjoyed the course!

```surql
-- All queries used for the course, minus the quick ones just used to explain a concept
-- Page 1: Nothing
-- ** PAGES 2 to 6: fooling around and then deleting **
-- Only part that remains is the automatically generated
-- DEFINE TABLE statements
-- Page 2
CREATE place SET place_type = "library";
CREATE place:my_library;
-- Page 3
CREATE place;
CREATE ONLY place;
-- Page 4
CREATE ONLY place:`ma_bibliothèque`;
CREATE ONLY place:`良い図書館`;
CREATE ONLY place:`𒂍𒁾𒁀𒀀`;
CREATE ONLY `📚📚`:`🧑‍🎓💪💪💪`;
-- Page 5
(CREATE place)[0];
(CREATE place).id;
(CREATE place SET place_type = "library", num_books = 10000).{
  place_type,
  num_books
};
-- Page 6
CREATE some_record;
DELETE some_record;
DELETE place RETURN BEFORE;
-- Page 7
CREATE place:surreal_library SET
    name = "Surreal Library",
    address = "2025 Statement Street, Riverdale",
  place_type = "library",
    floors = 8;
-- Page 8: Nothing
-- Page 9: Nothing
-- Page 10: Nothing
-- Page 11
CREATE town:riverdale SET name = "Riverdale";
UPDATE town
  SET population = 75000
  WHERE name = "Riverdale";
-- Page 12
UPDATE town:riverdale SET libraries = [place:surreal_library];
-- Page 13
REMOVE TABLE some_record;
-- Page 14: Nothing
-- Page 15
DEFINE FIELD address ON place TYPE string;
DEFINE FIELD name ON place TYPE string;
DEFINE FIELD name ON town TYPE string;
DEFINE FIELD population ON town TYPE int;
DEFINE FIELD libraries ON town TYPE option<array<record<place>>>;
-- Page 16
DEFINE FIELD place_type ON place TYPE "building" | "tower" | "store" | "school" | "park" | "library";
DEFINE FIELD OVERWRITE population ON town TYPE int ASSERT $value >= 0;
-- Page 17
-- Experimenting, 'person' records deleted later
INSERT INTO person [
    {
        "name": "Sara Bellum",
        "age": 30        
    },
    {
        "name": "Lydia Wyndham",
        "age": 25        
    },
    {
        "name": "Samm Schwartz",
        "age": 45        
    }
];
-- Page 18
-- Experimenting, 'person' records deleted later
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
DELETE person;
-- Page 19: Nothing
-- Page 20
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
    LET $created = CREATE ONLY person SET
        age = $person.age,
        name = $person.name;
    RELATE $created->works_at->place:surreal_library;
};
-- Page 21: Nothing
-- Page 22: Nothing
-- Page 23
DEFINE FIELD account_created ON TABLE customer_of VALUE time::now() READONLY;
DEFINE FIELD last_updated ON TABLE customer_of VALUE time::now();
DEFINE FIELD customer_for ON TABLE customer_of COMPUTED time::now() - account_created;
FOR $data IN [
  { age: 15, name: 'Archie Andrews'   },
  { age: 15, name: 'Veronica Lodge'   },
  { age: 15, name: 'Betty Cooper'     },
  { age: 15, name: 'Jughead Jones'    },
  { age: 15, name: 'Reggie Mantle'    },
  { age: 50, name: 'Hiram P. Lodge'   },
  { age: 55, name: 'Geraldine Grundy' },
  { age: 65, name: 'Waldo Weatherbee' }
] {
    LET $person = CREATE ONLY person SET
        name = $data.name,
        age = $data.age;
    RELATE $person->customer_of->place:surreal_library;
};
FOR $data IN 
[
  {
    author: 'Charles Dickens',
    english_title: 'A Tale of Two Cities',
    language: 'en',
    published: "1859-11-26",
    title: 'A Tale of Two Cities'
  },
  {
      author: "Antoine de Saint-Exupéry",
      english_title: "The Little Prince",
      language: "fr",
      published: "1943-04-15",
      title: "Le Petit Prince"
  },
  {
    author: 'Paulo Coelho',
    english_title: 'The Alchemist',
    language: 'pt',
    published: "1988-03-01",
    title: 'O Alquimista'
  },
  {
    author: 'J.K. Rowling',
    english_title: "Harry Potter and the Philosopher's Stone",
    language: 'en',
    published: "1997-06-26",
    title: "Harry Potter and the Philosopher's Stone"
  },
  {
    author: 'Agatha Christie',
    english_title: 'And Then There Were None',
    language: 'en',
    published: "1939-11-06",
    title: 'And Then There Were None'
  },
  {
    author: 'Cao Xueqin',
    english_title: 'Dream of the Red Chamber',
    language: 'zh',
    published: "1791-03-01",
    title: '紅樓夢'
  },
  {
    author: 'J.R.R. Tolkien',
    english_title: 'The Hobbit',
    language: 'en',
    published: "1937-09-21",
    title: 'The Hobbit'
  },
  {
    author: 'Lewis Carroll',
    english_title: "Alice's Adventures in Wonderland",
    language: 'en',
    published: "1865-07-04",
    title: "Alice's Adventures in Wonderland"
  }
] {
    -- Create the author for each book, return just the object
    LET $author = CREATE ONLY person SET
        name = $data.author;
    -- Create the book, cast 'published' field from string to datetime
    LET $book = CREATE ONLY book SET
        author = $data.author,
        english_title = $data.english_title,
        language = $data.language,
        published = <datetime>$data.published,
        title = $data.title;
    -- Connect the author to the book
    RELATE $author->wrote->$book;
    -- Give the book to the library with a few copies of each
    RELATE place:surreal_library->has->$book SET copies = rand::int(1, 10);
};
-- Page 24
DEFINE FIELD author ON book TYPE string;
DEFINE FIELD language ON book TYPE string;
DEFINE FIELD title ON book TYPE string;
DEFINE EVENT language_check ON book WHEN $event = "CREATE" THEN {
    IF $after.language = 'en' {
        UPDATE $after SET english_title = $after.title;
    } ELSE IF $after.language != 'en' AND $after.english_title IS NONE {
        THROW "Please enter an English title for " + $after.title + " written in " + $after.language;
    }
};
CREATE book SET title = "The Shadow Rising", author = "Robert Jordan", language = 'en';
-- Page 25
DEFINE INDEX unique_address ON TABLE place FIELDS address UNIQUE;
-- Page 26
DEFINE TABLE OVERWRITE works_at TYPE RELATION IN person OUT place;
DEFINE TABLE OVERWRITE wrote TYPE RELATION IN person OUT book;
DEFINE TABLE OVERWRITE has TYPE RELATION IN place OUT book;
DEFINE TABLE OVERWRITE customer_of TYPE RELATION IN person OUT place;
-- Page 27: Nothing
-- Page 28
CREATE street:bowler_hat_alley    SET name = "Bowler Hat Alley",    connected_to = [street:index_avenue, street:rust_row];
CREATE street:graph_query_lane    SET name = "Graph Query Lane",    connected_to = [street:push_to_main_street, street:recursive_crossing, street:statement_street];
CREATE street:index_avenue        SET name = "Index Avenue",        connected_to = [place:event_junction, place:surreal_square, place:surrealdb_university, street:bowler_hat_alley,street:record_link_way, street:rust_row, street:statement_street];
CREATE street:push_to_main_street SET name = "Push to Main Street", connected_to = [street:graph_query_lane, street:record_link_way,place:vector_park];
CREATE street:transaction_trail   SET name = "Transaction Trail",   connected_to = [street:rust_row];
CREATE street:record_link_way     SET name = "Record Link Way",     connected_to = [place:surreal_square, place:surrealdb_university, place:vector_park, street:index_avenue,street:push_to_main_street, street:statement_street];
CREATE street:recursive_crossing  SET name = "Recursive Crossing",  connected_to = [street:recursive_crossing, street:schema_boulevard, street:statement_street, NONE];
CREATE street:rust_row            SET name = "Rust Row",            connected_to = [place:idiom_tower, street:transaction_trail, street:bowler_hat_alley, street:index_avenue, street:schema_boulevard];
CREATE street:schema_boulevard    SET name = "Schema Boulevard",    connected_to = [place:access_court, street:rust_row, street:recursive_crossing];
CREATE street:statement_street    SET name = "Statement Street",    connected_to = [place:record_store, place:idiom_tower, street:index_avenue, street:record_link_way, street:recursive_crossing, street:graph_query_lane];
CREATE place:access_court SET
  address = "100 Schema Boulevard",   
  name = "Access Court",         
  place_type = "building",
  connected_to = [street:rust_row, street:schema_boulevard];
CREATE place:event_junction SET
  address = "50 Index Avenue",        
  name = "Event Junction",
  place_type = "building",
  connected_to = [street:index_avenue, street:rust_row];
CREATE place:idiom_tower SET
  address = "100 Statement Street",   
  name = "Idiom Tower",
  place_type = "tower",
  connected_to = [street:bowler_hat_alley, street:rust_row, street:schema_boulevard];
CREATE place:record_store SET
  address = "120 Statement Street",
  name = "Record Store",
  place_type = "store",
  connected_to = [street:record_link_way, street:statement_street]; 
CREATE place:surreal_square SET
  address = "100 Index Avenue",
  name = "Surreal Square",
  place_type = "park",
  connected_to = [place:surrealdb_university, street:index_avenue, street:record_link_way];
CREATE place:surrealdb_university SET
  address = "150 Index Avenue",
  name = "SurrealDB University",
  place_type = "school",
  connected_to = [place:surreal_square, street:index_avenue, street:record_link_way]; 
CREATE street:transaction_trail SET
  address = "60 Rust Row",
  name = "Transaction Trail",
  place_type = "park",
  connected_to = [street:rust_row];
CREATE place:vector_park SET
  address = "10 Push to Main Street",
  name = "Vector Park",
  place_type = "park",
  connected_to = [street:push_to_main_street, street:record_link_way];
UPDATE town:riverdale SET
    streets = SELECT VALUE id FROM street,
    buildings = [place:event_junction, place:access_court, place:record_store, place:idiom_tower],
    schools = [place:surrealdb_university];
-- Page 31
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
