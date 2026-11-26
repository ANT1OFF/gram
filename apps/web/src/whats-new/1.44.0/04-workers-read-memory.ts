import type { WhatsNewItem } from "../index";

export default {
  title: "Workers can read the workspace's memory again",
  body: "Workers no longer see their orchestrator's memory notes withheld because they mention ordinary identifiers such as an account number, an ARN or a commit. A note with a real secret in it still hides that part from them.",
} satisfies WhatsNewItem;
