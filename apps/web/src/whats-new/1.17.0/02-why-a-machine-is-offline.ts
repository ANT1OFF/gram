import type { WhatsNewItem } from "../index";

export default {
  title: "See why a machine is offline",
  body: "Hover a joined machine that's offline in Settings → Machines or the machine picker, and Gram says why, with the fix: it isn't confirmed yet, its clock is off, its connection dropped, Tailscale is turned off, and more. A machine whose gram-host can't talk to this Gram reads Needs update, with an Update button.",
} satisfies WhatsNewItem;
