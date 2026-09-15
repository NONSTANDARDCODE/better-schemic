import { defineFunction, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Function with args, return type, body",
  ddl: `DEFINE FUNCTION fn::greet($name: string) -> string { RETURN "hi " + $name };`,
  def: defineFunction("greet", { name: s.string() })
    .returns(s.string())
    .body(surql`RETURN "hi " + $name`),
});
