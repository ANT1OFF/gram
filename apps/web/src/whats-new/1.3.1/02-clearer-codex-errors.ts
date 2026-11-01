import type { WhatsNewItem } from "../index";

export default {
  title: "Clearer Codex errors",
  body: "When Codex can't find the model you picked, the turn now says Model unavailable instead of Turn failed. When Codex is out of capacity, it says Rate limited and can be retried.",
} satisfies WhatsNewItem;
