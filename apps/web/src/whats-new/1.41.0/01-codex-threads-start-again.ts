import type { WhatsNewItem } from "../index";

export default {
  title: "Codex threads start again after a slow start",
  body: "One Codex thread whose start got no answer could keep every later Codex thread from starting until Gram was restarted. Now only that one start fails: new Codex threads and workers open as usual, and the stuck Codex process stops once nothing uses it.",
} satisfies WhatsNewItem;
