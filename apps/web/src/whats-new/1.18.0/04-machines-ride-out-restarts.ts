import type { WhatsNewItem } from "../index";

export default {
  title: "Work on a joined machine survives its restart",
  body: "When a joined machine's gram-host restarts, for an update or a service restart, its sessions now continue where they left off instead of failing, and a command the restart cut off reads as interrupted. A machine on gram-host 1.18.0 also notices a connection that went silent and dials again, and this Gram sets Tailscale up again by itself once Tailscale is back.",
} satisfies WhatsNewItem;
