import type { WhatsNewItem } from "../index";

export default {
  title: "A new session knows the thread",
  body: "When an agent's own record of a conversation is gone and Gram has to open a new session, it now gives that session the thread's recent turns, so the agent carries on instead of starting over.",
} satisfies WhatsNewItem;
