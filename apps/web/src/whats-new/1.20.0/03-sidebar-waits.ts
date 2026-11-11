import type { WhatsNewItem } from "../index";

export default {
  title: "Sidebar statuses fit",
  body: "A worker waiting on a pull request now shows a glyph and the PR number at its row's edge instead of words cut short, so the title gets its room back, and a provider limit shows a gauge and its reset time. Hover the row for the whole status, which now wraps instead of being cut.",
} satisfies WhatsNewItem;
