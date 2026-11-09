import type { WhatsNewItem } from "../index";

export default {
  title: "Run work on your other machines",
  body: "A new worktree thread can now run on a joined machine: pick it in the Machine menu beside the branch fields, which appears once Settings → Machines has a confirmed machine. An orchestrator can place a worker it starts on a machine by name, and the Workers tab tags each worker that runs elsewhere with its machine's name. The Files panel, turn checkpoints and port chips still stay on this machine.",
} satisfies WhatsNewItem;
