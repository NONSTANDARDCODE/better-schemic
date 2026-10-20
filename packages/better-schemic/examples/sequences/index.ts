import { group } from "../_kit";
import e0 from "./basic-sequence";
import e1 from "./sequence-batch-start-timeout";

export const sequences = group(
  "sequences",
  "DEFINE SEQUENCE — db-level monotonic counters (BATCH / START / TIMEOUT)",
  [e0, e1],
);
