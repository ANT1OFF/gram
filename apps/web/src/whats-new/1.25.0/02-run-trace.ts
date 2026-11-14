import type { WhatsNewItem } from "../index";

export default {
  title: "See a turn as a trace",
  body: "Open trace, in a turn's run timeline, shows the turn in place of the conversation: each tool call on one time line, a subagent's calls under the call that started it, and where the time went. Esc or Conversation brings the chat back where you left it.",
} satisfies WhatsNewItem;
