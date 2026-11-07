import type { WhatsNewItem } from "../index";

export default {
  title: "New keys for approvals",
  body: "Approvals now answer to <kbd>1</kbd> Allow once, <kbd>2</kbd> Always allow this rule… (the first press shows the rule, the second saves it) and <kbd>3</kbd> Deny, on the thread card, in the Inbox and in Quiet. Each key acts as soon as you press it, and <kbd>↵</kbd>, <kbd>⌥↵</kbd> and <kbd>Esc</kbd> no longer answer an approval; rebind the keys in Settings → Keyboard.",
} satisfies WhatsNewItem;
