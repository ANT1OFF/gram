import type { WhatsNewItem } from "../index";

export default {
  title: "Workers keep workspace memory too",
  body: "Workers can now write, edit and delete workspace memory notes, not only read them. A note that changed since a worker read it is never overwritten.",
} satisfies WhatsNewItem;
