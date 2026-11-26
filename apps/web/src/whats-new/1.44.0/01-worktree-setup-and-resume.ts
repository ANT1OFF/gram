import type { WhatsNewItem } from "../index";

export default {
  title: "Worktrees set themselves up",
  body: "Commit an executable setup script in a repository's .gram folder and Gram runs it once in each new worktree it makes for a thread, to install dependencies or generate code; a resume script beside it runs before a worker's first turn, after a wake and on a restart. On your own machine Gram asks before it runs a new or changed script, the thread shows each result with its log, and a local merge check can use the same setup.",
} satisfies WhatsNewItem;
