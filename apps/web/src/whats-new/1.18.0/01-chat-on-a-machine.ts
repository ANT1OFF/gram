import type { WhatsNewItem } from "../index";

export default {
  title: "Start a chat on a joined machine, in any folder",
  body: "New → Chat now asks for the machine first. Pick a joined machine and the chat runs in its home folder, or in one of its recent folders or any other you type or browse to there, a git repository or not, and the thread's header names the machine and folder. Folders that hold credentials, such as SSH keys, are refused. The machine needs gram-host 1.18.0.",
} satisfies WhatsNewItem;
