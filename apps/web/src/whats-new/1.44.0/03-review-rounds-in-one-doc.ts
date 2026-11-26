import type { WhatsNewItem } from "../index";

export default {
  title: "A PR's review rounds share one doc",
  body: "Each new review round on a pull request now goes at the top of that PR's existing doc instead of starting another, and the version it replaces is kept, so one doc tells the whole review.",
} satisfies WhatsNewItem;
