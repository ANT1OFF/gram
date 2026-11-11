import type { WhatsNewItem } from "../index";

export default {
  title: "Gram's own messages join a running turn",
  body: "What Gram sends a working agent by itself, such as CI and review results, worker reports, wakes and messages between orchestrators and workers, now reaches the turn under way after its current tool call instead of waiting for the turn to end. Nothing is cancelled, and a turn waiting on your answer gets them only after you reply.",
} satisfies WhatsNewItem;
