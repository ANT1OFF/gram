import { eslintCompatPlugin } from "@oxlint/plugins";

import { noManualTaggedConstructionRule } from "./effect/rules/no-manual-tagged-construction.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";

/** The anti-slop rules Gram adopts; see UPSTREAM.md for where they come from. */
const antiSlopPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-manual-tagged-construction": noManualTaggedConstructionRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-reflect-get": noReflectGetRule,
    "no-widen-then-assert": noWidenThenAssertRule,
  },
});

export default antiSlopPlugin;
