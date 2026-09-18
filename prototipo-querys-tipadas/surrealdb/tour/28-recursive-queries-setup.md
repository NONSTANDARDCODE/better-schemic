# 28: Recursive queries: setup

With the town and library part of the database working well, we'll finish off the tour of SurrealDB by showing another one of its newest features: [recursive queries](/docs/learn/data-models/graph/recursive-traversals) and [algorithms](/docs/reference/query-language/language-primitives/idioms#path-and-unique-node-collection-shortest-path). Recursive queries let you move down multiple depths, while algorithms let you tell the database to follow all possible paths with a certain objective.

To make this happen, we'll first fill out the downtown section of Riverdale which you've seen throughout this tour in the image at the top. SurrealDB has three algorithms that help answer questions like this:

- What is the shortest path from Event Junction to Vector Park?

- What are all the paths within two steps from Event Junction? e.g. Event Junction to Index Avenue to Surreal Square, or Event Junction to Index Avenue to Statement Street...

- What are all the unique paths within two steps from Event Junction? e.g. Index Avenue, Surreal Square, Statement Street, but not Vector Park, which is much more than two steps away.

Try looking at the image on top as you think about what the answers might be.

To set the stage for this, we'll first need to add all of these streets and places. This could be done using `RELATE` statements, but simple record links work just as well so we will go with record links this time.

```surql
CREATE street:bowler_hat_alley    SET name = "Bowler Hat Alley",    connected_to = [street:index_avenue, street:rust_row];
CREATE street:graph_query_lane    SET name = "Graph Query Lane",    connected_to = [street:push_to_main_street, street:recursive_crossing, street:statement_street];
CREATE street:index_avenue        SET name = "Index Avenue",        connected_to = [place:event_junction, place:surreal_square, place:surrealdb_university, street:bowler_hat_alley,street:record_link_way, street:rust_row, street:statement_street];
CREATE street:push_to_main_street SET name = "Push to Main Street", connected_to = [street:graph_query_lane, street:record_link_way,place:vector_park];
CREATE street:transaction_trail   SET name = "Transaction Trail",   connected_to = [street:rust_row];
CREATE street:record_link_way     SET name = "Record Link Way",     connected_to = [place:surreal_square, place:surrealdb_university, place:vector_park, street:index_avenue,street:push_to_main_street, street:statement_street];
CREATE street:recursive_crossing  SET name = "Recursive Crossing",  connected_to = [street:recursive_crossing, street:schema_boulevard, street:statement_street];
CREATE street:rust_row            SET name = "Rust Row",            connected_to = [place:idiom_tower, street:transaction_trail, street:bowler_hat_alley, street:index_avenue, street:schema_boulevard];
CREATE street:schema_boulevard    SET name = "Schema Boulevard",    connected_to = [place:access_court, street:rust_row, street:recursive_crossing];
CREATE street:statement_street    SET name = "Statement Street",    connected_to = [place:record_store, place:idiom_tower, street:index_avenue, street:record_link_way, street:recursive_crossing, street:graph_query_lane];
CREATE place:access_court         SET address = "100 Schema Boulevard",   name = "Access Court",         place_type = "building", connected_to = [street:rust_row, street:schema_boulevard];
CREATE place:event_junction       SET address = "50 Index Avenue",        name = "Event Junction",       place_type = "building", connected_to = [street:index_avenue, street:rust_row];
CREATE place:idiom_tower          SET address = "100 Statement Street",   name = "Idiom Tower",          place_type = "tower",    connected_to = [street:bowler_hat_alley, street:rust_row, street:schema_boulevard];
CREATE place:record_store         SET address = "120 Statement Street",   name = "Record Store",         place_type = "store",    connected_to = [street:record_link_way, street:statement_street]; 
CREATE place:surreal_square       SET address = "100 Index Avenue",       name = "Surreal Square",       place_type = "park",     connected_to = [place:surrealdb_university, street:index_avenue, street:record_link_way];
CREATE place:surrealdb_university SET address = "150 Index Avenue",       name = "SurrealDB University", place_type = "school",   connected_to = [place:surreal_square, street:index_avenue, street:record_link_way]; 
CREATE street:transaction_trail    SET address = "60 Rust Row",            name = "Transaction Trail",    place_type = "park",     connected_to = [street:rust_row];
CREATE place:vector_park          SET address = "10 Push to Main Street", name = "Vector Park",          place_type = "park",     connected_to = [street:push_to_main_street, street:record_link_way];
UPDATE town:riverdale SET
    streets = SELECT VALUE id FROM street,
    buildings = [place:event_junction, place:access_court, place:record_store, place:idiom_tower],
    schools = [place:surrealdb_university];
```

The street called Bowler Hat Alley, by the way, is the little one that provides a shortcut from Rust Row to Index Avenue and has a building with an actual bowler hat on the top.

Also note that one of the streets is an interesting one, a set of bridges and stairs that cross the river at the bottom of the image. This mysterious location is a bit of a maze. Sometimes it takes you to where you want to go, but other times you can't find your way out, and other times you end up back at the place where you entered. That's why locals call it Recursive Crossing.

That's why this one is connected not only to two streets, but also to itself, and the value `NONE`.

```surql
CREATE street:recursive_crossing SET
  connected_to = [street:recursive_crossing, street:schema_boulevard, street:statement_street, NONE];
```
