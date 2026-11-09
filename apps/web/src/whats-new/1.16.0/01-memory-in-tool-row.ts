import type { WhatsNewItem } from "../index";

export default {
  title: "Memory updates sit in the tool row",
  body: 'When an orchestrator updates its memory between tool calls, the change now joins that run of tools instead of splitting it with a card of its own. The row reads "Updated memory" alongside the rest, and opening it shows the change and its diff.',
} satisfies WhatsNewItem;
