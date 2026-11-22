import type { WhatsNewItem } from "../index";

export default {
  title: "Moved threads and workers lose nothing",
  body: "A thread moved to another server, a worker brief held while the server stops, and the reply of a worker sent to a server are no longer lost.",
} satisfies WhatsNewItem;
