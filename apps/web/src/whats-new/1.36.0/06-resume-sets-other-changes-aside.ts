import type { WhatsNewItem } from "../index";

export default {
  title: "Resuming keeps changes left in the clone",
  body: "A thread that works in a machine's own clone, such as an orchestrator, now resumes even when other changes were left there: Gram commits them to an aside branch first and names it in the resume note.",
} satisfies WhatsNewItem;
