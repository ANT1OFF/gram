import type { WhatsNewItem } from "../index";

export default {
  title: "Workers can wait for more",
  body: "A worker can now wait for main to move, another worker to finish, a CI job stuck without a runner or a fork's pull request needing approval, your Mac getting quieter or running low on disk, a new upstream release, or an installed version changing. It wakes on its own when that happens.",
} satisfies WhatsNewItem;
