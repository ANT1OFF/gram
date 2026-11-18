import type { WhatsNewItem } from "../index";

export default {
  title: "See what a thread is waiting for",
  body: "The sidebar shows a symbol for each condition a thread is waiting on, with a date for later wakes. Stop also ends a provider-limit wait, so the thread stays stopped until you ask it to continue.",
} satisfies WhatsNewItem;
