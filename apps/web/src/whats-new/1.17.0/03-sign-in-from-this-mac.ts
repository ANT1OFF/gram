import type { WhatsNewItem } from "../index";

export default {
  title: "Sign a machine in to Claude from this Mac",
  body: "Use a token from this Mac, in Settings → Machines, signs joined machines in to Claude without a browser on each one. It runs Claude Code's setup-token here and sends the token only to the machines you tick, where only that machine's Claude sessions use it. Forget token deletes it from a machine again. The machine needs gram-host 1.17.0.",
} satisfies WhatsNewItem;
