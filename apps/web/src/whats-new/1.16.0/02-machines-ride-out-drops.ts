import type { WhatsNewItem } from "../index";

export default {
  title: "Joined machines ride out a network drop",
  body: "A short drop in the connection to a joined machine no longer ends its sessions. The machine keeps its agents running while it reconnects, and this Gram picks up each session where it left off, with no events lost. Both this Gram and the machine's gram-host need 1.16.0 for this: run the install command on that machine again after updating.",
} satisfies WhatsNewItem;
