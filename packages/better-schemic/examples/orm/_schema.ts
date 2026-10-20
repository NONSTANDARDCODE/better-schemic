/**
 * The shared sample schema the ORM cookbook examples run against. One `user`/`post` table, a `likes`
 * relation, and a `profile` table — enough to demonstrate reads, writes, relations and plugins without
 * smuggling a real connection. Pure authoring (`defineTable`/`defineRelation`), no side effects.
 */
import { defineRelation, defineTable, s } from "better-schemic";
import { defineSchema } from "better-schemic/orm";

export const User = defineTable("user", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string() }),
}).index("uniq_email", ["email"], { unique: true });

export const Post = defineTable("post", {
  title: s.string(),
  published: s.boolean(),
});

export const Likes = defineRelation("likes", { score: s.int() })
  .from(User)
  .to(Post);

/** A table opting into UUID v7 ids (`rand::uuid()`) for ORM creates. */
export const UuidUser = defineTable("uuid_user", {
  name: s.string(),
  email: s.string(),
})
  .idStrategy("uuid")
  .index("uq_uuid_email", ["email"], { unique: true });

/** A table opting back into the server default (`rand::id()`, 20 chars). */
export const RandUser = defineTable("rand_user", {
  name: s.string(),
}).idStrategy("rand");

/**
 * A cart whose `lines` is the array a UNWIND+GROUP aggregate walks (`aggregate({ split })`) — the
 * shape that otherwise forced a `findMany({ split })` plus a JS reduction over the whole history.
 */
export const Line = defineTable("line", {
  label: s.string(),
  quantity: s.int(),
  price: s.decimal(),
});

export const Cart = defineTable("cart", {
  name: s.string(),
  lines: s.array(s.recordId(() => Line)),
});

/** Multi-tenant: `email` is unique only WITHIN a tenant, so the index is the PAIR. */
export const Account = defineTable("account", {
  tenant: s.string(),
  email: s.string(),
  name: s.string(),
}).index("uq_account_tenant_email", ["tenant", "email"], { unique: true });

/** A string-id table: the app speaks bare ids (`owner: "u1"`), the wire gets `RecordId`s. */
export const Customer = defineTable("customer", {
  name: s.string(),
  owner: s.recordId(User),
}).stringIds();

export const schema = defineSchema({
  users: User,
  posts: Post,
  likes: Likes,
  uuidUsers: UuidUser,
  randUsers: RandUser,
  customers: Customer,
  lines: Line,
  carts: Cart,
  accounts: Account,
});
