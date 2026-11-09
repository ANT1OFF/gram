import type { WhatsNewItem } from "../index";

export default {
  title: "Joined machines stay connected",
  body: "Sessions on a joined machine no longer drop when this Mac is slow to look up that machine's folders. Gram now leaves paths that belong to another machine alone instead of checking them on this one, so the connection stays up and its threads keep running.",
} satisfies WhatsNewItem;
