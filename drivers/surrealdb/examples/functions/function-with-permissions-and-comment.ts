import { defineFunction, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Function with PERMISSIONS and COMMENT",
  ddl: `DEFINE FUNCTION fn::tax($amount: float) -> float { RETURN $amount * 0.21 } PERMISSIONS $auth.id != NONE COMMENT "VAT helper";`,
  def: defineFunction("tax", { amount: s.float() })
    .returns(s.float())
    .body(surql`RETURN $amount * 0.21`)
    .permissions(surql`$auth.id != NONE`)
    .comment("VAT helper"),
});
