import type { WhatsNewItem } from "../index";

export default {
  title: "Tokens on each reply",
  body: "Hover a reply to see how many tokens its turn used, beside its time. Hover or click the count for the breakdown: input, cache read and write, output and thinking, the share read from the prompt cache, and how full the context is after the turn. Replies from before this update show no count.",
} satisfies WhatsNewItem;
