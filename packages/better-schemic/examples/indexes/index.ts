import { group } from "../_kit";
import e5 from "./comment";
import e1 from "./composite-index-via-renameable-field-refs-callba";
import e4 from "./count-materialized-row-count-no-fields";
import e9 from "./fulltext-search-index-define-analyzer";
import e10 from "./fulltext-single-field-inline-via-field-fulltext";
import e11 from "./fulltext-with-no-analyzer-surrealdb-s-built-in-l";
import e0 from "./plain-and-composite-index";
import e2 from "./unique-composite-named-via-table-index";
import e3 from "./unique-single-field-inline-via-field-unique";
import e8 from "./vector-diskann-minimal";
import e13 from "./vector-diskann-single-field-inline-via-field-dis";
import e6 from "./vector-hnsw-minimal-defaults-stripped";
import e12 from "./vector-hnsw-single-field-inline-via-field-hnsw";
import e7 from "./vector-hnsw-tuned";

export const indexes = group(
  "indexes",
  "DEFINE INDEX — plain/unique/composite/count/comment/HNSW/DISKANN/FULLTEXT (+ DEFINE ANALYZER)",
  [e0, e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12, e13],
);
