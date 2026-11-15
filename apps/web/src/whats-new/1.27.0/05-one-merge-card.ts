import type { WhatsNewItem } from "../index";

export default {
  title: "One approval card per merge",
  body: "Asking for the same merge twice raises one card instead of two, and a card for a pull request that has already merged or closed goes away by itself.",
} satisfies WhatsNewItem;
