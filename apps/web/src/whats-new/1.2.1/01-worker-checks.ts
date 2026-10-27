import type { WhatsNewItem } from "../index";

export default {
  title: "Failing checks stay with the worker",
  body: "When checks fail on a worker's pull request and the worker can still act, the fix stays with the worker instead of asking you. Needs you, the Board's Failing strip, the sidebar badge and away notifications list failing checks only when no agent can fix them.",
} satisfies WhatsNewItem;
