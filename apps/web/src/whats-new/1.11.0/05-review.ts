import type { WhatsNewItem } from "../index";

export default {
  title: "One toolbar for code review",
  body: "Split or unified view, Wrap lines, Hide whitespace changes and File tree now sit in one toolbar above the diff, and long lines wrap by default. Focus review keeps the thread's title, any decision waiting on you and the latest message beside the code, and a finished thread whose worktree is gone lists its pull request's changed files. The side panel's tabs keep their names and fold the rarer ones into More, and with nothing uncommitted the diff shows the branch's changes instead.",
} satisfies WhatsNewItem;
