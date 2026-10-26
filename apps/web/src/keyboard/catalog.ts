import type { ExperimentalSettings, Settings } from "@gram/contracts";

import type { ShortcutGroup } from "./registry";

export interface ShortcutDefinition {
  id: string;
  /** Default keys; `keybindings.json` may override or disable them. */
  keys: string;
  label: string;
  group: ShortcutGroup;
  /** The experimental switch its feature is still behind: listed only while that is on. */
  experimental?: keyof ExperimentalSettings;
}

const paneMove = (
  [
    ["left", "arrowleft"],
    ["right", "arrowright"],
    ["up", "arrowup"],
    ["down", "arrowdown"],
  ] as const
).map(([direction, key]): ShortcutDefinition => ({
  id: `pane.move-${direction}`,
  keys: `mod+alt+${key}`,
  label: `Move focus ${direction}`,
  group: "Navigation",
}));

/** Ctrl+Shift+1…6 pick the layout presets in the picker's order, on every platform (⌘⇧3–5 are macOS screenshots). */
const layoutPresets = [1, 2, 3, 4, 5, 6].map((n): ShortcutDefinition => ({
  id: `layout.preset${n}`,
  keys: `ctrl+shift+${n}`,
  label: `Layout preset ${n}`,
  group: "Navigation",
}));

/** ⌘1–⌘9 switch workspace in the Orchestrator layout, where the switcher replaces the sidebar. */
const workspaceSwitch = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): ShortcutDefinition => ({
  id: `workspace.switch${n}`,
  keys: `mod+${n}`,
  label: `Workspace ${n}`,
  group: "Navigation",
}));

/**
 * Every app shortcut and its default keys. Components still register their own handlers, but this is
 * the list Settings → Keyboard shows and `keybindings.json` ids refer to; a test keeps it in step
 * with the registrations.
 */
export const SHORTCUT_CATALOG: readonly ShortcutDefinition[] = [
  { id: "palette.open", keys: "mod+k", label: "Command palette", group: "App" },
  { id: "palette.actions", keys: "mod+shift+p", label: "Actions", group: "App" },
  { id: "overlay.shortcuts", keys: "?", label: "Keyboard shortcuts", group: "App" },
  {
    id: "overlay.shortcutsAnywhere",
    keys: "mod+/",
    label: "Keyboard shortcuts, also while typing",
    group: "App",
  },
  { id: "settings.open", keys: "mod+,", label: "Settings", group: "App" },
  { id: "settings.close", keys: "escape", label: "Leave settings", group: "App" },
  { id: "settings.search", keys: "mod+f", label: "Search settings", group: "App" },
  { id: "sidebar.toggle", keys: "mod+b", label: "Collapse / expand sidebar", group: "App" },
  { id: "panel.toggle", keys: "mod+alt+b", label: "Show / hide right panel", group: "App" },
  { id: "panel.restore", keys: "escape", label: "Restore expanded right panel", group: "App" },
  { id: "focus.toggle", keys: "mod+shift+.", label: "Focus mode", group: "App" },
  { id: "panel.refresh", keys: "mod+alt+r", label: "Refresh Diff / PR panel", group: "App" },
  { id: "diff.nextHunk", keys: "n", label: "Next change in the diff", group: "Navigation" },
  {
    id: "diff.previousHunk",
    keys: "p",
    label: "Previous change in the diff",
    group: "Navigation",
  },
  { id: "sidebar.focus", keys: "mod+alt+s", label: "Focus sidebar", group: "App" },
  { id: "panel.focus", keys: "mod+alt+p", label: "Focus right panel", group: "App" },
  { id: "thread.new", keys: "mod+n", label: "New task", group: "Navigation" },
  {
    id: "thread.newInProject",
    keys: "mod+t",
    label: "New one-off thread",
    group: "Navigation",
  },
  {
    id: "window.openThread",
    keys: "mod+shift+o",
    label: "Open thread in new window",
    group: "Navigation",
  },
  { id: "window.new", keys: "mod+shift+n", label: "New window", group: "App" },
  {
    id: "thread.cycleNext",
    keys: "ctrl+tab",
    label: "Switch threads, most recent first (hold Ctrl)",
    group: "Navigation",
  },
  {
    id: "thread.cyclePrev",
    keys: "ctrl+shift+tab",
    label: "Switch threads backwards",
    group: "Navigation",
  },
  {
    id: "thread.reopenClosed",
    keys: "mod+shift+t",
    label: "Reopen closed thread",
    group: "Thread",
  },
  {
    id: "thread.nextNeedsYou",
    keys: "mod+shift+u",
    label: "Next that needs you, at its turn",
    group: "Navigation",
  },
  {
    id: "needsYou.previous",
    keys: "mod+shift+y",
    label: "Previous that needs you, at its turn",
    group: "Navigation",
  },
  {
    id: "orchestration.board",
    keys: "mod+shift+d",
    label: "Open board",
    group: "Navigation",
  },
  { id: "workers.open", keys: "mod+j", label: "Workers", group: "Navigation" },
  { id: "view.chat", keys: "mod+alt+1", label: "Chat", group: "Navigation" },
  { id: "view.board", keys: "mod+alt+2", label: "Board", group: "Navigation" },
  { id: "view.needsYou", keys: "mod+alt+3", label: "Needs you", group: "Navigation" },
  { id: "view.quiet", keys: "mod+alt+4", label: "Quiet", group: "Navigation" },
  { id: "view.back", keys: "escape", label: "Back to Chat", group: "Navigation" },
  { id: "quiet.leave", keys: "escape", label: "Leave quiet", group: "Navigation" },
  { id: "worker.back", keys: "escape", label: "Back to the orchestrator", group: "Navigation" },
  { id: "history.back", keys: "mod+[", label: "Back", group: "Navigation" },
  { id: "history.forward", keys: "mod+]", label: "Forward", group: "Navigation" },
  ...workspaceSwitch,
  { id: "split.toggle", keys: "mod+\\", label: "Keep beside / split", group: "Navigation" },
  {
    id: "pane.maximize",
    keys: "mod+shift+enter",
    label: "Maximize / restore pane",
    group: "Navigation",
  },
  ...paneMove,
  { id: "pane.previous", keys: "mod+shift+[", label: "Focus previous pane", group: "Navigation" },
  { id: "pane.next", keys: "mod+shift+]", label: "Focus next pane", group: "Navigation" },
  ...layoutPresets,
  {
    id: "pane.close",
    keys: "mod+w",
    label: "Close pane (the thread keeps running)",
    group: "Navigation",
  },
  { id: "thread.find", keys: "mod+f", label: "Find in thread", group: "Thread" },
  {
    id: "thread.previousMessage",
    keys: "alt+arrowup",
    label: "Previous message",
    group: "Thread",
  },
  { id: "thread.nextMessage", keys: "alt+arrowdown", label: "Next message", group: "Thread" },
  { id: "message.copy", keys: "mod+shift+c", label: "Copy focused message", group: "Thread" },
  {
    id: "subagent.jump",
    keys: "mod+alt+j",
    label: "Jump to a running subagent (again for the next)",
    group: "Thread",
  },
  { id: "thread.rename", keys: "f2", label: "Rename thread…", group: "Thread" },
  { id: "thread.close", keys: "mod+alt+w", label: "Close thread…", group: "Thread" },
  { id: "approval.allow", keys: "enter", label: "Allow", group: "Thread" },
  { id: "approval.always", keys: "alt+enter", label: "Allow always", group: "Thread" },
  { id: "approval.deny", keys: "escape", label: "Deny", group: "Thread" },
  {
    id: "composer.send",
    keys: "mod+enter",
    label: "Send (queues while running)",
    group: "Composer",
  },
  {
    id: "composer.sendNewDraft",
    keys: "mod+alt+enter",
    label: "Send and start a new draft",
    group: "Composer",
  },
  { id: "composer.focus", keys: "mod+l", label: "Focus composer", group: "Composer" },
  { id: "composer.model", keys: "mod+shift+m", label: "Pick model", group: "Composer" },
  { id: "composer.effort", keys: "mod+shift+e", label: "Pick effort", group: "Composer" },
  { id: "composer.mode", keys: "mod+shift+a", label: "Pick mode", group: "Composer" },
  { id: "composer.stash", keys: "mod+s", label: "Stash the draft", group: "Composer" },
  {
    id: "composer.dictate",
    keys: "mod+shift+space",
    label: "Dictate: tap to start or stop, hold to talk",
    group: "Composer",
    experimental: "voiceInput",
  },
  // Answered in the composer's text area through `shortcutPressed`, and only while a suggested
  // reply shows there, so they shadow nothing: the caret is already at the end.
  {
    id: "composer.acceptSuggestion",
    keys: "arrowright",
    label: "Accept the suggestion (while one shows)",
    group: "Composer",
  },
  {
    id: "composer.acceptSuggestionWord",
    keys: "alt+arrowright",
    label: "Accept the suggestion's next word (while one shows)",
    group: "Composer",
  },
  {
    id: "composer.nextSuggestion",
    keys: "alt+arrowdown",
    label: "Next suggestion (while one shows)",
    group: "Composer",
  },
  {
    id: "composer.previousSuggestion",
    keys: "alt+arrowup",
    label: "Previous suggestion (while one shows)",
    group: "Composer",
  },
  {
    id: "draft.create",
    keys: "mod+enter",
    label: "Create thread, start the task, or create the workspace",
    group: "Composer",
  },
  { id: "terminal.zoomIn", keys: "mod+=", label: "Zoom in terminal", group: "Terminal" },
  { id: "terminal.zoomOut", keys: "mod+-", label: "Zoom out terminal", group: "Terminal" },
  { id: "terminal.zoomReset", keys: "mod+0", label: "Reset terminal zoom", group: "Terminal" },
  { id: "terminal.find", keys: "mod+f", label: "Find in terminal", group: "Terminal" },
  { id: "terminal.findNext", keys: "mod+g", label: "Find next in terminal", group: "Terminal" },
  {
    id: "terminal.findPrevious",
    keys: "mod+shift+g",
    label: "Find previous in terminal",
    group: "Terminal",
  },
];

export const catalogKeys = (id: string): string | undefined =>
  SHORTCUT_CATALOG.find((definition) => definition.id === id)?.keys;

/** The catalog as the shortcut lists show it: without shortcuts of features switched off. */
export const listedShortcuts = (
  catalog: readonly ShortcutDefinition[],
  settings: Settings | undefined,
): readonly ShortcutDefinition[] =>
  catalog.filter(
    (definition) =>
      definition.experimental === undefined ||
      settings?.experimental?.[definition.experimental] === true,
  );
