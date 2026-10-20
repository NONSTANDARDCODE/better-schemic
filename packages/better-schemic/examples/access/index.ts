import { group } from "../_kit";
import e3 from "./bearer-access-api-key-grants";
import e2 from "./jwt-access-validate-external-tokens";
import e0 from "./record-access-signup-signin-duration";
import e1 from "./record-access-with-authenticate";

export const access = group(
  "access",
  "DEFINE ACCESS — RECORD/JWT/BEARER, SIGNUP/SIGNIN/AUTHENTICATE, DURATION, ON NS/DB",
  [e0, e1, e2, e3],
);
