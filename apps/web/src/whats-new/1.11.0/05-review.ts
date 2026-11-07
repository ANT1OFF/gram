import type { WhatsNewItem } from "../index";

export default {
  title: "One toolbar for code review",
  body: "Split or unified view, Wrap lines, Hide whitespace changes and File tree now sit in one toolbar above the diff, and long lines wrap by default. Focus review keeps the thread's title and its latest message, links and code included, beside the diff, answers a waiting approval with <kbd>1</kbd>, <kbd>2</kbd> and <kbd>3</kbd>, and shows the same tabs as the side panel, which keeps their names and folds the rarer ones into More. A large diff opens on its first readable file, with nothing uncommitted the diff shows the branch's changes instead, and a finished thread whose worktree is gone lists its pull request's changed files.",
} satisfies WhatsNewItem;
