import type { WhatsNewItem } from "../index";

export default {
  title: "A rate limit reads as the wait",
  body: "When a provider turns a request away, the thread no longer shows its API error as the agent's reply. The waiting line says what the provider said, under the time it tries again.",
} satisfies WhatsNewItem;
