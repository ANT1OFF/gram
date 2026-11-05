/**
 * One line each for Gram's own words, where they are offered: what it does, who acts while it
 * holds, and how it ends. The words themselves stay; this is what a tooltip or a menu item's
 * second line says of them.
 */
export const EXPLAIN = {
  solo: "Single agent chats outside any workspace: you direct one agent in one folder, with no orchestrator.",
  dreams:
    "Gram rereads finished threads and drafts an update to this workspace's memory, with a source for each change. Memory changes once the draft is adopted.",
  takeOver:
    "You direct this worker yourself and the orchestrator stops messaging it. Hand back from its header to return it.",
  startHeld:
    "You direct it yourself, and the orchestrator can't message it until you hand it back from its header.",
  tidyUp:
    "The orchestrator archives what's done, fixes groups, stages and plans, closes settled questions and refreshes its memory, then says what it changed.",
  discover:
    "One read-only worker surveys the repos. The orchestrator records what it found and asks which starter tasks to start; nothing starts until you pick.",
  pause:
    "The orchestrator and its workers finish their current step and stop. Nothing wakes them until you resume.",
  resume: "The orchestrator and its workers pick up where they stopped.",
  quiet:
    "Hides the busy work and shows only what needs you, one card at a time. Agents keep working; Esc leaves it.",
} as const;
