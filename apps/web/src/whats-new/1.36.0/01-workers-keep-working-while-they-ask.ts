import type { WhatsNewItem } from "../index";

export default {
  title: "Workers keep working while they ask",
  body: "A Claude worker now asks its questions without stopping: each goes to its orchestrator first and reaches your Inbox if the orchestrator can't settle it. The question card says who holds it and when it comes to you, and pausing a workspace brings its waiting questions to your Inbox at once.",
} satisfies WhatsNewItem;
