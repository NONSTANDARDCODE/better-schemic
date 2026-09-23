/**
 * The shared sample schema the ORM cookbook examples run against. One `user`/`post` table, a `likes`
 * relation, and a `profile` table — enough to demonstrate reads, writes, relations and plugins without
 * smuggling a real connection. Pure authoring (`defineTable`/`defineRelation`), no side effects.
 */
import { defineRelation, defineTable, s } from "@better-schemic/surrealdb";
import { defineSchema } from "@better-schemic/surrealdb/orm";

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

export const schema = defineSchema({
  users: User,
  posts: Post,
  likes: Likes,
});
