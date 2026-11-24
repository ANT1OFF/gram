import type { WhatsNewItem } from "../index";

export default {
  title: "Workers grow their own machine for heavy work",
  body: "A worker on a machine of its own can ask its provider for more memory and CPU before a big build or test run, and give it back afterwards, so the machine stays small the rest of the time. Where the provider doesn't resize machines, the worker is told so.",
} satisfies WhatsNewItem;
