import {
  chimeOf,
  DEFAULT_SETTINGS,
  helperDailyBudgetUsd,
  helperSource,
  helperLocalFallback,
  restartOnMcpChangeOn,
  reviewRequestsAwaitBot,
  reviewRequestsAwaitChecks,
  reviewRequestsDirectOnly,
  reviewRequestsHideBots,
  reviewRequestsMaxAgeDays,
  noticeActionsOn,
  notifyAboutOf,
  openAtLaunchOf,
  OVERVIEW_HIDDEN_BY_DEFAULT,
  overviewHiddenOf,
  overviewSidebarOf,
  reviewRequestsOn,
  sendKeyOf,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";

import { useLayoutStore } from "@/stores/layout";

import { branchPrefixSetting } from "./branch-prefix";

/** A setting that can be put back to its default, from its row or its page's Restore defaults. */
export interface DefaultSetting {
  /** The row's label, which Restore defaults lists. */
  readonly label: string;
  /** The value as the app reads it, so an unset key and the default it stands for compare equal. */
  readonly read: (settings: Settings) => unknown;
  /** The patch that puts the default back. */
  readonly reset: SettingsPatch;
  /** Review-request filters also rebuild the list once saved. */
  readonly refreshesReviewRequests?: boolean;
  /** Puts back what this window keeps of it besides the server, once the reset is saved. */
  readonly afterRestore?: () => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const isDefault = (setting: DefaultSetting, settings: Settings): boolean =>
  same(setting.read(settings), setting.read(DEFAULT_SETTINGS));

/** The settings among `list` that differ from their defaults, in `list`'s order. */
export const changedSettings = (
  list: readonly DefaultSetting[],
  settings: Settings,
): DefaultSetting[] => list.filter((setting) => !isDefault(setting, settings));

/** One patch that resets every setting in `list`, merged a section at a time. */
export const restorePatch = (list: readonly DefaultSetting[]): SettingsPatch => {
  const merged: Record<string, unknown> = {};
  for (const { reset } of list) {
    for (const [key, value] of Object.entries(reset)) {
      const before = merged[key];
      merged[key] =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? { ...(before as object | undefined), ...value }
          : value;
    }
  }
  return merged as SettingsPatch;
};

const DEFAULT_CHIME = chimeOf(DEFAULT_SETTINGS.notifications);

/** A page's settings by key, so a row names its own and the page lists them all. */
const defaults = <K extends string>(settings: Record<K, DefaultSetting>) => settings;

/** Settings → General. */
export const GENERAL_DEFAULTS = defaults({
  openAtLaunch: {
    label: "Open at launch",
    read: openAtLaunchOf,
    reset: { layout: { openAtLaunch: null } },
  },
  overviewSidebar: {
    label: "Overview sidebar",
    read: overviewSidebarOf,
    reset: { layout: { overviewSidebar: null } },
    // The window lays it out from the layout store, which the settings sync keeps.
    afterRestore: () => useLayoutStore.getState().setOverviewSidebar(undefined),
  },
  overviewSections: {
    label: "Sidebar sections",
    read: overviewHiddenOf,
    reset: { layout: { overviewSections: null } },
    // Laid out from the layout store too, which the settings sync keeps.
    afterRestore: () => useLayoutStore.getState().setOverviewHidden(OVERVIEW_HIDDEN_BY_DEFAULT),
  },
  defaultFolder: {
    label: "Default folder",
    read: (s) => s.agents.defaultFolder,
    reset: { agents: { defaultFolder: null } },
  },
  cloneFolder: {
    label: "Where new clones go",
    read: (s) => s.agents.cloneFolder,
    reset: { agents: { cloneFolder: null } },
  },
  branchPrefix: {
    label: "Branch prefix",
    read: (s) => branchPrefixSetting(s.agents.branchPrefix),
    reset: { agents: { branchPrefix: null } },
  },
  sendKey: {
    label: "Send with",
    read: sendKeyOf,
    reset: { composer: { sendKey: sendKeyOf(DEFAULT_SETTINGS) } },
  },
  panelSide: {
    label: "Side panel",
    read: (s) => s.panel.side,
    reset: { panel: { side: DEFAULT_SETTINGS.panel.side } },
  },
  followWorktreeMoves: {
    label: "Follow worktree moves",
    read: (s) => s.agents.followWorktreeMoves,
    reset: { agents: { followWorktreeMoves: DEFAULT_SETTINGS.agents.followWorktreeMoves } },
  },
  quietWhenIdle: {
    label: "Quiet when idle",
    read: (s) => s.layout?.quietWhenIdle === true,
    reset: { layout: { quietWhenIdle: null } },
  },
  notifyAbout: {
    label: "Notify me about",
    read: notifyAboutOf,
    reset: { notifications: { notifyAbout: null } },
  },
  editor: {
    label: "Open in editor",
    read: (s) => s.editor.command,
    reset: { editor: { command: null } },
  },
});

/** Settings → Agents. */
export const AGENTS_DEFAULTS = defaults({
  defaultModel: {
    label: "Default agent and model",
    read: (s) => s.agents.defaultModel,
    reset: { agents: { defaultModel: null } },
  },
  defaultMode: {
    label: "Default mode",
    read: (s) => s.agents.defaultMode,
    reset: { agents: { defaultMode: DEFAULT_SETTINGS.agents.defaultMode } },
  },
  idleEvictMinutes: {
    label: "Close idle sessions after",
    read: (s) => s.agents.idleEvictMinutes,
    reset: { agents: { idleEvictMinutes: DEFAULT_SETTINGS.agents.idleEvictMinutes } },
  },
  restartOnMcpChange: {
    label: "Restart on MCP change",
    read: restartOnMcpChangeOn,
    reset: { agents: { restartOnMcpChange: restartOnMcpChangeOn(DEFAULT_SETTINGS) } },
  },
});

/** Settings → Notifications. Where review requests show is kept on this computer, and isn't here. */
export const NOTIFICATIONS_DEFAULTS = defaults({
  native: {
    label: "Desktop notifications",
    read: (s) => s.notifications.native,
    reset: { notifications: { native: DEFAULT_SETTINGS.notifications.native } },
  },
  sound: {
    label: "Sound",
    read: (s) => chimeOf(s.notifications),
    reset: {
      notifications:
        DEFAULT_CHIME === undefined ? { sounds: false } : { sounds: true, chime: DEFAULT_CHIME },
    },
  },
  actions: {
    label: "Actions in notifications",
    read: noticeActionsOn,
    reset: { notifications: { actions: noticeActionsOn(DEFAULT_SETTINGS) } },
  },
  mutedWorkspaces: {
    label: "Muted workspaces",
    read: (s) => s.notifications.mutedWorkspaces ?? [],
    reset: { notifications: { mutedWorkspaces: [] } },
  },
  reviewRequests: {
    label: "Check for review requests",
    read: reviewRequestsOn,
    reset: { notifications: { reviewRequests: reviewRequestsOn(DEFAULT_SETTINGS) } },
    refreshesReviewRequests: true,
  },
  directOnly: {
    label: "Direct requests only",
    read: reviewRequestsDirectOnly,
    reset: {
      notifications: { reviewRequestsDirectOnly: reviewRequestsDirectOnly(DEFAULT_SETTINGS) },
    },
    refreshesReviewRequests: true,
  },
  hideBots: {
    label: "Hide bot pull requests",
    read: reviewRequestsHideBots,
    reset: { notifications: { reviewRequestsHideBots: reviewRequestsHideBots(DEFAULT_SETTINGS) } },
    refreshesReviewRequests: true,
  },
  maxAge: {
    label: "Maximum age",
    read: reviewRequestsMaxAgeDays,
    reset: {
      notifications: {
        reviewRequestsMaxAgeDays: reviewRequestsMaxAgeDays(DEFAULT_SETTINGS) ?? null,
      },
    },
    refreshesReviewRequests: true,
  },
  awaitChecks: {
    label: "Wait for checks",
    read: reviewRequestsAwaitChecks,
    reset: {
      notifications: { reviewRequestsAwaitChecks: reviewRequestsAwaitChecks(DEFAULT_SETTINGS) },
    },
    refreshesReviewRequests: true,
  },
  awaitBot: {
    label: "Wait for review bot",
    read: reviewRequestsAwaitBot,
    reset: { notifications: { reviewRequestsAwaitBot: reviewRequestsAwaitBot(DEFAULT_SETTINGS) } },
    refreshesReviewRequests: true,
  },
});

/** Settings → AI helpers. Local helper consent starts off; source defaults to local subscriptions. */
export const AI_HELPERS_DEFAULTS = defaults({
  source: { label: "Helper source", read: helperSource, reset: { helpers: { source: null } } },
  claudeModel: {
    label: "Claude helper model",
    read: (s) => s.helpers?.claudeModel,
    reset: { helpers: { claudeModel: null } },
  },
  codexModel: {
    label: "Codex helper model",
    read: (s) => s.helpers?.codexModel,
    reset: { helpers: { codexModel: null } },
  },
  claudeEffort: {
    label: "Claude helper effort",
    read: (s) => s.helpers?.claudeEffort,
    reset: { helpers: { claudeEffort: null } },
  },
  codexEffort: {
    label: "Codex helper effort",
    read: (s) => s.helpers?.codexEffort,
    reset: { helpers: { codexEffort: null } },
  },
  localFallback: {
    label: "Local helper fallback",
    read: helperLocalFallback,
    reset: { helpers: { localFallback: null } },
  },
  claudeContext: {
    label: "Helper context to Claude Code / Anthropic",
    read: (s) => s.helpers?.claudeContext ?? "off",
    reset: { helpers: { claudeContext: null } },
  },
  codexContext: {
    label: "Helper context to Codex / OpenAI",
    read: (s) => s.helpers?.codexContext ?? "off",
    reset: { helpers: { codexContext: null } },
  },
  enabled: {
    label: "Use the helper model",
    read: (s) => s.helpers?.enabled !== false,
    reset: { helpers: { enabled: null } },
  },
  title: {
    label: "Thread titles",
    read: (s) => s.helpers?.title !== false,
    reset: { helpers: { title: null } },
  },
  plan: {
    label: "Thread plans",
    read: (s) => s.helpers?.plan !== false,
    reset: { helpers: { plan: null } },
  },
  recap: {
    label: "Where you left off",
    read: (s) => s.helpers?.recap !== false,
    reset: { helpers: { recap: null } },
  },
  suggest: {
    label: "Suggested replies",
    read: (s) => s.helpers?.suggest !== false,
    reset: { helpers: { suggest: null } },
  },
  wait: {
    label: "Waiting on you",
    read: (s) => s.helpers?.wait !== false,
    reset: { helpers: { wait: null } },
  },
  notice: {
    label: "Notification titles",
    read: (s) => s.helpers?.notice !== false,
    reset: { helpers: { notice: null } },
  },
  stuck: {
    label: "Why is it stuck?",
    read: (s) => s.helpers?.stuck !== false,
    reset: { helpers: { stuck: null } },
  },
  dailyBudgetUsd: {
    label: "Gateway estimate limit",
    read: helperDailyBudgetUsd,
    reset: { helpers: { dailyBudgetUsd: null } },
  },
});

/** Settings → Terminal. */
export const TERMINAL_DEFAULTS = defaults({
  shell: {
    label: "Windows terminal shell",
    read: (s) => s.terminal.shell ?? "powershell",
    reset: { terminal: { shell: null } },
  },
});

/** Settings → Appearance → Fonts. */
export const FONTS_DEFAULTS = defaults({
  ui: { label: "Interface font", read: (s) => s.fonts.ui, reset: { fonts: { ui: null } } },
  mono: { label: "Monospace font", read: (s) => s.fonts.mono, reset: { fonts: { mono: null } } },
  monoSize: {
    label: "Terminal font size",
    read: (s) => s.fonts.monoSize,
    reset: { fonts: { monoSize: null } },
  },
});

/** Settings → Diagnostics. */
export const DIAGNOSTICS_DEFAULTS = defaults({
  logLevel: {
    label: "Log level",
    read: (s) => s.logLevel,
    reset: { logLevel: DEFAULT_SETTINGS.logLevel },
  },
});

/** A row's `onReset`: absent while the setting is at its default, else a save of its reset patch. */
export const resetFor =
  (settings: Settings, apply: (patch: SettingsPatch) => void) =>
  (setting: DefaultSetting): (() => void) | undefined =>
    isDefault(setting, settings) ? undefined : () => apply(setting.reset);

/** "A", "A and B", "A, B and C". */
export const listLabels = (labels: readonly string[]): string =>
  labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!}`;
