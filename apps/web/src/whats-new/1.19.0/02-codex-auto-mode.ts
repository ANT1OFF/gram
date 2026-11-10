import type { WhatsNewItem } from "../index";

export default {
  title: "Codex workers run in Auto",
  body: "Codex orchestrators and workers now start in Auto instead of Bypass wherever no push or merge gate applies, so Codex's own auto-review approves or refuses each riskier step and you hear only when it can't go on. Under Supervised and Publish, and with an older Codex CLI, they start as before.",
} satisfies WhatsNewItem;
