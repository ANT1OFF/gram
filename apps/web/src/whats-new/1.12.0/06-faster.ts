import type { WhatsNewItem } from "../index";

export default {
  title: "Faster with long threads",
  body: "Opening, resuming and checking long threads reads only the messages it needs, and search and the usage overview run beside the app instead of holding it up, so Gram stays quick as your history grows. Branch and pull request status refresh with less work.",
} satisfies WhatsNewItem;
