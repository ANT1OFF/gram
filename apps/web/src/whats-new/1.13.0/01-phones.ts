import type { WhatsNewItem } from "../index";

export default {
  title: "Use Gram from your phone",
  body: "Settings → Machines → Phones and browsers turns on phone access over your Tailscale network, pairs a phone or browser from a QR code, and lists every paired browser with when it was last seen. Remove one, or all, and its open session closes at once. If Tailscale isn't ready, the page lists what it still needs, and Gram never opens access to the public internet.",
} satisfies WhatsNewItem;
