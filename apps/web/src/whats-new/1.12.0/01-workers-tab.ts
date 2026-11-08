import type { WhatsNewItem } from "../index";

export default {
  title: "Every worker in one list, on ⌘J",
  body: "The Workers tab in the side panel is now the one list of your workers, grouped by state, each row with its title and one status line that turns amber while the worker needs you, and its pull request chips while they fit. <kbd>⌘J</kbd> opens it with focus on its rows, and pressing it again puts the panel back. <kbd>↑</kbd> and <kbd>↓</kbd> move between workers, <kbd>↵</kbd> opens one beside the chat and <kbd>⌘↵</kbd> in the main view. While the tab is open, the sidebar folds that workspace's workers to one line.",
} satisfies WhatsNewItem;
