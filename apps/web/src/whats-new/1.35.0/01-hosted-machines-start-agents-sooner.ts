import type { WhatsNewItem } from "../index";

export default {
  title: "Hosted machines start agents sooner",
  body: "A machine a hosted server starts for one worker now gets that worker's first session going sooner. It checks only the agent it runs, and it connects back to Gram without waiting out a retry.",
} satisfies WhatsNewItem;
