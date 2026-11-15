import type { WhatsNewItem } from "../index";

export default {
  title: "Writing to a worker keeps it with its orchestrator",
  body: "Typing in a worker's thread no longer detaches it. Its orchestrator's messages wait until your exchange is done, and the worker's own reports and merges keep working.",
} satisfies WhatsNewItem;
