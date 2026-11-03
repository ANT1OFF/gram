import type { WhatsNewItem } from "../index";

export default {
  title: "See what each agent is waiting on",
  body: "When a worker or orchestrator is waiting, an hourglass line under its name says on what: checks, a review, a run or a wake. The sidebar, the Board and the Workers list in <kbd>⌘J</kbd> all say the same, and hovering shows every wait.",
} satisfies WhatsNewItem;
