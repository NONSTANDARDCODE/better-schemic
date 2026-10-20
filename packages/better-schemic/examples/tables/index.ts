import { group } from "../_kit";
import e5 from "./changefeed";
import e3 from "./comment";
import e6 from "./drop";
import e9 from "./pre-computed-view-as-select";
import e0 from "./schemafull-the-default";
import e1 from "./schemaless";
import e4 from "./table-permissions";
import e2 from "./type-any";
import e7 from "./type-relation-edge-table-with-from-to-enforced";
import e8 from "./type-relation-unrestricted-endpoints";

export const tables = group(
  "tables",
  "DEFINE TABLE head — schema mode, type, permissions, changefeed, comment, drop, relations, views",
  [e0, e1, e2, e3, e4, e5, e6, e7, e8, e9],
);
