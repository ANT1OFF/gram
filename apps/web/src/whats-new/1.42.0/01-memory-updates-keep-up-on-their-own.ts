import type { WhatsNewItem } from "../index";

export default {
  title: "Memory updates keep up, and can apply themselves",
  body: "A memory update now reads what happened since the last one (worker reports, merges, answers and each thread's recap) instead of whole transcripts, so it stays small and picks up where it stopped. On the Memory page's Memory updates tab, choose Review or Auto, set how often it runs or use Update now, and Revert an update that applied itself.",
} satisfies WhatsNewItem;
