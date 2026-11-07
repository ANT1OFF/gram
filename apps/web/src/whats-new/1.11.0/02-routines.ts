import type { WhatsNewItem } from "../index";

export default {
  title: "Run work on a schedule with routines",
  body: "A routine is a brief that comes due every day, on weekdays, weekly at a time like 09:00, or every few hours, and starts a worker or goes to the orchestrator. Settings → Routines lists every workspace's routines and edits each in its own dialog; add one there, in the workspace's settings, or ask the orchestrator. An agent that creates, turns back on or widens a routine always asks you first on an approval card, and routines run only while Gram is open.",
} satisfies WhatsNewItem;
