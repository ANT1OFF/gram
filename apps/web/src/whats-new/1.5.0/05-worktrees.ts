import type { WhatsNewItem } from "../index";

export default {
  title: "Tidier worktrees",
  body: "Finished workers' worktrees are cleaned up sooner, including ones whose pull request merged and ones that never had one. A worktree is kept while it has unsaved changes or something is still running in it.",
} satisfies WhatsNewItem;
