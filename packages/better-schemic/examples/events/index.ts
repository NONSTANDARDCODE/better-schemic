import { group } from "../_kit";
import e3 from "./async-event-retry-maxdepth";
import e1 from "./event-without-when-fires-on-every-change";
import e0 from "./inline-event-with-when-then";
import e2 from "./standalone-event-with-an-ordered-then-array";

export const events = group(
  "events",
  "DEFINE EVENT — inline and standalone, WHEN/THEN (single or ordered array), ASYNC RETRY/MAXDEPTH",
  [e0, e1, e2, e3],
);
