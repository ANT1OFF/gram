import type { WhatsNewItem } from "../index";

export default {
  title: "Hosted workers merge on CI",
  body: "A worker on a hosted server's machine no longer runs the full check on that small machine before merging. Its pull request merges once the CI the repository declares for merges has passed on it.",
  shell: "desktop",
} satisfies WhatsNewItem;
