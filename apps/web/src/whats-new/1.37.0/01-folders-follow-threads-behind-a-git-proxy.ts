import type { WhatsNewItem } from "../index";

export default {
  title: "Threads keep their folders on machines behind a git proxy",
  body: "On a machine whose git sends GitHub through a proxy, a stopping thread's work in progress is kept again, and its repository folder comes back when the work moves to a fresh machine.",
} satisfies WhatsNewItem;
