import type { WhatsNewItem } from "../index";

export default {
  title: "Memory updates wait until enough has happened",
  body: "An automatic memory update now starts only once enough time has passed and enough new work has come in since the last one (24 hours and 50 new items to begin with), so a quiet workspace spends no model time on it. Change both under More options in a workspace's settings, and its Memory page shows how long and how many items are left.",
} satisfies WhatsNewItem;
