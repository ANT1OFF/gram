import type { WhatsNewItem } from "../index";

export default {
  title: "Steer, queue or interrupt a working thread",
  body: "While a thread works, <kbd>Enter</kbd> now steers: your message reaches the agent after the tool calls under way, and nothing is cancelled. <kbd>⌥Enter</kbd> queues it for when the turn ends, and <kbd>⌘.</kbd> stops the turn and sends it in one step; the chevron beside the send button lists all three, and a sent message says Steered or Interrupted the turn. Gram's own notices now wait for the turn to end instead of cutting off the agent's tool calls.",
} satisfies WhatsNewItem;
