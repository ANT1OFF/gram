import type { WhatsNewItem } from "../index";

export default {
  title: "Routines that start on events",
  body: "A routine can now start when something happens instead of on a clock: a review is requested from you, a pull request is ready for review, CI fails on a branch, or a package publishes a release. Choose When something happens in its dialog in Settings → Routines; Gram looks with your own GitHub CLI and npm, never a webhook, and fires only for what is new after you add it. Once a workspace has an event routine, an older Gram can't read that workspace's routines, so don't downgrade after creating one.",
} satisfies WhatsNewItem;
