import type { WhatsNewItem } from "../index";

export default {
  title: "Updates restart in one click",
  body: "Restart to update now goes through on the first click: Gram no longer refuses its own restart after it stops the old server, and when an agent doesn't stop cleanly it tries once more by itself. A small Restarting to update window says what it's stopping while it works.",
  shell: "desktop",
} satisfies WhatsNewItem;
