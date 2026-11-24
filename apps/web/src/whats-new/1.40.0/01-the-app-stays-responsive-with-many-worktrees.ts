import type { WhatsNewItem } from "../index";

export default {
  title: "The app stays responsive with many old worktrees",
  body: "Gram's server could sit at full CPU checking folders that had been kept for removed worktrees, leaving the app stuck on Reconnecting to the server. It now checks those folders far less often, so the app stays responsive however many worktrees have come and gone.",
} satisfies WhatsNewItem;
