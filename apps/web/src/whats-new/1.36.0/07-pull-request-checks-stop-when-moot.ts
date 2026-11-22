import type { WhatsNewItem } from "../index";

export default {
  title: "A pull request's check stops once it no longer matters",
  body: "Gram's own check of a pull request now stops when the pull request merges, closes, gets a new push or has its merge called off. It never runs twice for the same commit, and the thread that owns it can cancel it.",
} satisfies WhatsNewItem;
