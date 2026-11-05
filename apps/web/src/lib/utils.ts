import type { CnFunction } from "cn";
import { createCn } from "cn/config";
import { TYPE_STEPS } from "@gram/themes";

/**
 * Tailwind class merging that knows Gram's tokens (DESIGN.md → Tokens). Without them, `text-meta`
 * reads as a text colour and `cn("text-meta", "text-muted-foreground")` drops the size; the
 * radius, shadow and spacing names would merge as unknown classes and never replace each other.
 */
export const cn: CnFunction = createCn({
  extend: {
    theme: {
      text: [...TYPE_STEPS, "code"],
      radius: ["2xs"],
      shadow: ["raised", "overlay", "composer"],
      spacing: ["tight", "inset", "list", "section"],
    },
  },
});
