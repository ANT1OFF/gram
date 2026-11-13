import type { WhatsNewItem } from "../index";

export default {
  title: "A broken edit keeps your last good shortcuts and scripts",
  body: "If an edit breaks your keybindings file or a project's scripts file, Gram keeps using the last version that worked, instead of resetting your shortcuts or emptying the Run script menu, and writes what's wrong to an error file you and your agents can read.",
} satisfies WhatsNewItem;
