import type { WhatsNewItem } from "../index";

export default {
  title: "Docs can be archived, searched and restored",
  body: "The Docs tab has a Search by title box, an Archive button on each doc and an Archived section at the foot where Restore brings one back. A PR's doc is archived a week after the PR merges or closes and a worker's other docs two weeks after it is archived, never the orchestrator's or one you opened lately; change that, or archive older docs at once, in the Docs card on the Storage settings page.",
} satisfies WhatsNewItem;
