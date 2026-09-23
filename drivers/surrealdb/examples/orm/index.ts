import { liveChanges } from "./live-changes";
import { rawAdmin } from "./raw-admin";
import { reads } from "./reads";
import { relations } from "./relations";
import { writes } from "./writes";

export type { OrmExample, OrmGroup, OrmStatement } from "./_kit";
export { capture, group, ormExample } from "./_kit";

/** Every ORM example group, in reading order. The reference test + manifest generator iterate this. */
export const allOrmGroups = [reads, writes, relations, rawAdmin, liveChanges];
