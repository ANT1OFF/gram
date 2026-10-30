import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { RuntimeSourceChoice } from "./agent-runtime.ts";
import { ChimeSound } from "./chime.ts";
import { AgentKind, ModelRef, PermissionMode, ReasoningVariant } from "./domain.ts";
import {
  HelperContextScope,
  HelperLocalFallback,
  HelperSource,
  type HelperKind,
} from "./helper.ts";
import { PaletteId, ThreadId } from "./ids.ts";
import type { ReviewRequestHolds } from "./review-requests.ts";
import { DEFAULT_REVIEW_BOTS, ReviewBot } from "./review.ts";
import { SPEECH_MODEL_FOR_STOP, SpeechPerformanceStop, type SpeechModelId } from "./speech.ts";
import { connectorEntryProblem, WorkerModel } from "./workspaces.ts";

/** Glass is the only look. */
export const Look = Schema.Literal("glass");
export type Look = typeof Look.Type;

export const ColorMode = Schema.Literals(["system", "light", "dark"]);
export type ColorMode = typeof ColorMode.Type;

export const Density = Schema.Literals(["compact", "comfortable"]);
export type Density = typeof Density.Type;

export const Contrast = Schema.Literals(["standard", "more"]);
export type Contrast = typeof Contrast.Type;

export const MotionPreference = Schema.Literals(["system", "reduced", "off"]);
export type MotionPreference = typeof MotionPreference.Type;

const HexColor = Schema.String.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/),
);

/** The ten theme seed tokens every palette is generated from. */
export const PaletteSeeds = Schema.Struct({
  bg: HexColor,
  surface: HexColor,
  text: HexColor,
  muted: HexColor,
  accent: HexColor,
  accent2: HexColor,
  red: HexColor,
  green: HexColor,
  yellow: HexColor,
  cyan: HexColor,
});
export type PaletteSeeds = typeof PaletteSeeds.Type;

export const PaletteMode = Schema.Literals(["light", "dark"]);
export type PaletteMode = typeof PaletteMode.Type;

/** Mirrors `Palette` in `@gram/themes`. */
export const Palette = Schema.Struct({
  id: PaletteId,
  name: Schema.String,
  /** The mode the seeds were designed for; a palette never renders in the other mode. */
  mode: PaletteMode,
  /** The palette to switch to when the other mode is requested. */
  pairId: Schema.optionalKey(PaletteId),
  seeds: PaletteSeeds,
  /** Server-side flag on the seeded presets, which can't be removed. Not part of the themes shape. */
  builtin: Schema.optionalKey(Schema.Boolean),
});
export type Palette = typeof Palette.Type;

export const LogLevel = Schema.Literals(["error", "warn", "info", "debug", "trace"]);
export type LogLevel = typeof LogLevel.Type;

export const AppearanceSettings = Schema.Struct({
  look: Look,
  paletteId: PaletteId,
  mode: ColorMode,
  density: Density,
  contrast: Contrast,
  motion: MotionPreference,
  /**
   * Dollar cost for threads on a gateway profile's own API key. Off when absent: subscriptions are
   * limits, which the usage meter shows, not bills.
   */
  showCost: Schema.optionalKey(Schema.Boolean),
});

export const SidebarSettings = Schema.Struct({
  /** `flat` is one list in the user's manual order (`Thread.sortOrder`). */
  grouping: Schema.Literals(["status", "project", "flat"]),
  width: Schema.Int,
  collapsed: Schema.Boolean,
  collapsedGroups: Schema.Array(Schema.String),
  /**
   * Groups that start collapsed and the user opened. Those groups read this list instead of
   * `collapsedGroups`; absent means none were opened.
   */
  expandedGroups: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Threads the user said "Not now" to when the sidebar suggested parking them, as
   * `<thread id> <epoch ms until>`, capped at `PARK_SNOOZE_LIMIT`. Absent means none.
   */
  parkSnoozed: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** The most "Not now"s the sidebar keeps; a new one past it drops the oldest. */
export const PARK_SNOOZE_LIMIT = 200;

export const PanelTab = Schema.Literals([
  "diff",
  "pr",
  "files",
  "terminal",
  "connectors",
  "reviews",
  "notifications",
  "preview",
  "needsYou",
]);
export type PanelTab = typeof PanelTab.Type;

export const PanelSettings = Schema.Struct({
  side: Schema.Literals(["left", "right"]),
  open: Schema.Boolean,
  /** Pixels; the client clamps to 240–640. */
  width: Schema.Int,
  tab: PanelTab,
});

export const EditorSettings = Schema.Struct({
  /** Open-in-editor command, e.g. `code -g`. */
  command: Schema.optionalKey(Schema.String),
});

export const FontSettings = Schema.Struct({
  ui: Schema.optionalKey(Schema.String),
  mono: Schema.optionalKey(Schema.String),
  monoSize: Schema.optionalKey(Schema.Int),
});

export const TerminalSettings = Schema.Struct({
  /** The Windows shell: `powershell`, `pwsh`, `cmd`, `git-bash`, or an executable path. */
  shell: Schema.optionalKey(Schema.String),
});

/**
 * A model the user added by id, for one the agent doesn't list itself: an early-access model, or a
 * variant such as `opus[1m]`. The id goes to the agent as written; nothing checks that it exists.
 */
export const CustomModel = Schema.Struct({
  agent: AgentKind,
  id: Schema.NonEmptyString,
  /** What the picker shows; absent means the id. */
  name: Schema.optionalKey(Schema.String),
  /** Whether the picker offers reasoning efforts for it. Absent means it does. */
  effort: Schema.optionalKey(Schema.Boolean),
});
export type CustomModel = typeof CustomModel.Type;

/** Which key sends a message: plain Enter (Shift+Enter for a new line), or only ⌘/Ctrl+Enter. */
export const SendKey = Schema.Literals(["enter", "modEnter"]);
export type SendKey = typeof SendKey.Type;

export const ComposerSettings = Schema.Struct({
  /** Absent means `enter`; read through `sendKeyOf`. */
  sendKey: Schema.optionalKey(SendKey),
});
export type ComposerSettings = typeof ComposerSettings.Type;

export const AgentSettings = Schema.Struct({
  defaultModel: Schema.optionalKey(ModelRef),
  /** Absent until a model is added; read through `customModelsOf`. */
  customModels: Schema.optionalKey(Schema.Array(CustomModel)),
  defaultMode: PermissionMode,
  /** Folder the project picker starts in for a new thread; may contain `~`. */
  defaultFolder: Schema.optionalKey(Schema.String),
  /** The prefix a new worktree's branch starts with, such as `fix`; absent means `feat`. */
  branchPrefix: Schema.optionalKey(Schema.String),
  /** Where a clone goes, as `<cloneFolder>/<repo>`; read through `cloneFolderOf`. */
  cloneFolder: Schema.optionalKey(Schema.String),
  /** Close live sessions idle this long; pinned threads are exempt. */
  idleEvictMinutes: Schema.Int,
  followWorktreeMoves: Schema.Boolean,
  /**
   * Restarts a live session once it is idle after an MCP server or connector its agent uses
   * changes through Gram. Absent means on; read through `restartOnMcpChangeOn`.
   */
  restartOnMcpChange: Schema.optionalKey(Schema.Boolean),
  /**
   * The worker model roster a new workspace's charter starts with; absent or empty starts it with
   * none, so its workers run on the orchestrator's model.
   */
  workerModels: Schema.optionalKey(Schema.Array(WorkerModel)),
  /**
   * Which Codex new sessions start: Gram's managed one, or (absent) the user's own. Not in
   * `SettingsPatch`: only `agentRuntime.useSource` changes it, since a change has to retire the
   * running app-servers too.
   */
  codexRuntime: Schema.optionalKey(RuntimeSourceChoice),
});

/** Days of inactivity a listed PR may have; a cutoff is only meaningful above zero. */
const MaxAgeDays = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * What interrupts you while the window isn't in front: `asksAndFailures` (asks, wants-you notices
 * and failures) or `asks` (failures wait for "Since you left").
 */
export const NotifyAbout = Schema.Literals(["asksAndFailures", "asks"]);
export type NotifyAbout = typeof NotifyAbout.Type;

export const NotificationSettings = Schema.Struct({
  native: Schema.Boolean,
  sounds: Schema.Boolean,
  /** Absent until one is chosen; read through `chimeOf`. */
  chime: Schema.optionalKey(ChimeSound),
  /**
   * Polls GitHub for open PRs requesting the user's review and notifies for new ones. Absent means
   * on; read through `reviewRequestsOn`.
   */
  reviewRequests: Schema.optionalKey(Schema.Boolean),
  /**
   * Lists only PRs that ask for the user's review by name, not ones requested from a team they
   * belong to. Absent means on; read through `reviewRequestsDirectOnly`.
   */
  reviewRequestsDirectOnly: Schema.optionalKey(Schema.Boolean),
  /**
   * Leaves out PRs opened by a GitHub App, such as dependabot. Absent means on; read through
   * `reviewRequestsHideBots`.
   */
  reviewRequestsHideBots: Schema.optionalKey(Schema.Boolean),
  /**
   * Leaves out PRs untouched for more than this many days. Absent means no cutoff; read through
   * `reviewRequestsMaxAgeDays`.
   */
  reviewRequestsMaxAgeDays: Schema.optionalKey(MaxAgeDays),
  /**
   * Holds a PR's notification until its checks pass. Absent means off; read through
   * `reviewRequestsAwaitChecks`.
   */
  reviewRequestsAwaitChecks: Schema.optionalKey(Schema.Boolean),
  /**
   * Holds a PR's notification until a review bot is content with its head commit. Absent means
   * off; read through `reviewRequestsAwaitBot`.
   */
  reviewRequestsAwaitBot: Schema.optionalKey(Schema.Boolean),
  /**
   * The repositories (`owner/name`, any case) a review bot reviews, the only ones
   * `reviewRequestsAwaitBot` holds for. Absent means every repository, as before the list existed,
   * until the app fills it in; read through `reviewRequestHolds`.
   */
  reviewBotRepos: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Allow and Merge on an ask's desktop notification, which answer it as the ask stack does.
   * Absent means on; read through `noticeActionsOn`.
   */
  actions: Schema.optionalKey(Schema.Boolean),
  /** Workspaces whose asks never raise a desktop notification. Absent means none. */
  mutedWorkspaces: Schema.optionalKey(Schema.Array(Schema.String)),
  /** What may raise a desktop notification while the window isn't in front; read through `notifyAboutOf`. */
  notifyAbout: Schema.optionalKey(NotifyAbout),
});

export const UpdateSettings = Schema.Struct({
  /** Explicit opt-in; absent means off. */
  automaticChecks: Schema.optionalKey(Schema.Boolean),
  /**
   * The server also mirrors the channel to `gram.updatePrerelease` in Gram's prefs file, where the
   * desktop shell reads it.
   */
  channel: Schema.Literals(["stable", "prerelease"]),
  pinnedVersion: Schema.optionalKey(Schema.String),
});

/** The release channel, as persisted and as the desktop updater checks it. */
export type UpdateChannel = typeof UpdateSettings.fields.channel.Type;

export const OnboardingSettings = Schema.Struct({
  lastSeenVersion: Schema.optionalKey(Schema.String),
  welcomeSeen: Schema.Boolean,
  /**
   * Launch-check problems the user dismissed, as `<app version>:<issue id>`. Issue ids name the check
   * result, so a different result or a new app version shows the problem again.
   */
  dismissedLaunchIssues: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The home page's offer to set up the AI gateway was turned down; Settings still has it. */
  gatewayOfferDismissed: Schema.optionalKey(Schema.Boolean),
  /** The new-workspace guide (what an orchestrator, workers and the board are) was read or skipped. */
  workspaceGuideSeen: Schema.optionalKey(Schema.Boolean),
});

export const GridPreset = Schema.Literals(["1", "2c", "3c", "2x2", "2x3", "3c2r"]);
export type GridPreset = typeof GridPreset.Type;

/** Columns and rows per preset (`2x3` is 2 columns × 3 rows); the pane count is their product. */
export const GRID_SHAPES: Readonly<
  Record<GridPreset, { readonly cols: number; readonly rows: number }>
> = {
  "1": { cols: 1, rows: 1 },
  "2c": { cols: 2, rows: 1 },
  "3c": { cols: 3, rows: 1 },
  "2x2": { cols: 2, rows: 2 },
  "2x3": { cols: 2, rows: 3 },
  "3c2r": { cols: 3, rows: 2 },
};

const Fractions = Schema.Array(Schema.Finite.check(Schema.isGreaterThan(0)));

export const GridLayout = Schema.Struct({
  preset: GridPreset,
  /** One entry per pane, row by row; `null` is an empty pane. */
  panes: Schema.Array(Schema.NullOr(ThreadId)),
  /** Relative column widths, one per column. */
  colFr: Schema.optionalKey(Fractions),
  /** Relative row heights, one per row. */
  rowFr: Schema.optionalKey(Fractions),
  /** Index into `panes` of the focused pane. */
  focused: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).check(
  Schema.makeFilter((grid) => {
    const { cols, rows } = GRID_SHAPES[grid.preset];
    if (grid.panes.length !== cols * rows)
      return `preset ${grid.preset} needs ${cols * rows} panes`;
    if (grid.colFr !== undefined && grid.colFr.length !== cols)
      return `preset ${grid.preset} needs ${cols} column fractions`;
    if (grid.rowFr !== undefined && grid.rowFr.length !== rows)
      return `preset ${grid.preset} needs ${rows} row fractions`;
    if (grid.focused !== undefined && grid.focused >= grid.panes.length)
      return `focused pane ${grid.focused} is out of range`;
    return true;
  }),
);
export type GridLayout = typeof GridLayout.Type;

/** What a launch opens: the orchestrator used last, or whichever thread the window showed last. */
export const OpenAtLaunch = Schema.Literals(["orchestrator", "thread"]);
export type OpenAtLaunch = typeof OpenAtLaunch.Type;

/**
 * The Orchestrator layout's overview sidebar down the window's left: open, compact (a narrow rail)
 * or hidden. Absent means automatic: open on a wide window.
 */
export const OverviewSidebar = Schema.Literals(["open", "compact", "hidden"]);
export type OverviewSidebar = typeof OverviewSidebar.Type;

/** The overview sidebar's optional sections, each turned on or off in Settings → General. */
export const OVERVIEW_OPTIONAL_SECTIONS = ["solo", "pullRequests", "doneToday", "usage"] as const;
export type OverviewOptionalSection = (typeof OVERVIEW_OPTIONAL_SECTIONS)[number];

/** The sections off until turned on: the title bar's meter owns usage. */
export const OVERVIEW_HIDDEN_BY_DEFAULT: readonly OverviewOptionalSection[] = ["usage"];

/**
 * Which of the overview sidebar's optional sections show: solo threads, pull requests, Done today,
 * and the footer's usage and worker slots. Only what differs from the default is stored; absent is
 * the default (`OVERVIEW_HIDDEN_BY_DEFAULT`).
 */
export const OverviewSections = Schema.Struct({
  solo: Schema.optionalKey(Schema.Boolean),
  pullRequests: Schema.optionalKey(Schema.Boolean),
  doneToday: Schema.optionalKey(Schema.Boolean),
  usage: Schema.optionalKey(Schema.Boolean),
});
export type OverviewSections = typeof OverviewSections.Type;

export const LayoutSettings = Schema.Struct({
  grid: Schema.optionalKey(GridLayout),
  /** Only the chat is shown, with the sidebar and right panel hidden. Absent means false. */
  focusMode: Schema.optionalKey(Schema.Boolean),
  /** The window drops into Quiet by itself when it sits idle with nothing asked. Absent means false. */
  quietWhenIdle: Schema.optionalKey(Schema.Boolean),
  /** What a launch opens; read through `openAtLaunchOf`. */
  openAtLaunch: Schema.optionalKey(OpenAtLaunch),
  /** The overview sidebar in the Orchestrator layout; read through `overviewSidebarOf`. */
  overviewSidebar: Schema.optionalKey(OverviewSidebar),
  /** The overview's optional sections unlike their default; read through `overviewHiddenOf`. */
  overviewSections: Schema.optionalKey(OverviewSections),
});
export type LayoutSettings = typeof LayoutSettings.Type;

export const AttentionSettings = Schema.Struct({
  /**
   * The PR attention each thread's user has seen, as `<thread id> <attention key>`, most recently seen
   * last and capped. A key names the head commit and review round, so a new failure raises again.
   */
  acknowledged: Schema.Array(Schema.String),
});

/**
 * What the Inbox view set aside. Each `snoozed` entry is `<id> <epoch ms until>`, split at its last
 * space, since a question's id can hold spaces; an id is a request's, an open question's or a
 * failure's. `cleared` lists failures by occurrence, so a new failure shows again. Both are capped
 * at `INBOX_SET_ASIDE_LIMIT`, the oldest dropped first. Absent means none.
 */
export const InboxSettings = Schema.Struct({
  snoozed: Schema.optionalKey(Schema.Array(Schema.String)),
  cleared: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type InboxSettings = typeof InboxSettings.Type;

/** The most snoozes, and the most cleared failures, the Inbox keeps. */
export const INBOX_SET_ASIDE_LIMIT = 200;

/**
 * Switches for features that started out as experiments. The key keeps its name after a feature
 * graduates, so a stored choice carries over; each reader says what an absent key means.
 */
export const ExperimentalSettings = Schema.Struct({
  /** Local dictation into the composer. Read through `voiceInputOn`; off unless turned on. */
  voiceInput: Schema.optionalKey(Schema.Boolean),
});
export type ExperimentalSettings = typeof ExperimentalSettings.Type;

/** Days a finished thread's worktree is left alone before the sweep takes a step. */
const SweepDays = Schema.Int.check(Schema.isGreaterThan(0));

const OrchestratorConnector = Schema.String.check(
  Schema.makeFilter((entry: string) => connectorEntryProblem(entry) ?? true),
);

/** Local checks at once: each runs a project's whole check, so a few already fill a machine. */
const LocalCheckConcurrency = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }));

export const WorkspaceSettings = Schema.Struct({
  /**
   * Workers a restart cut off mid-turn are asked once, at boot, to continue where they left off.
   * Read through `continueAfterRestart`; absent, it is off. An explicit saved choice wins.
   */
  continueAfterRestart: Schema.optionalKey(Schema.Boolean),
  /**
   * The sweep that frees finished threads' `node_modules` and later removes their worktrees, every
   * thread kind's. Read through `worktreeSweepOf`; with no saved choice, it is on.
   */
  worktreeSweep: Schema.optionalKey(Schema.Boolean),
  /** Days after a thread finished before its `node_modules` are freed; read through `worktreeSweepOf`. */
  worktreeSweepFreeDays: Schema.optionalKey(SweepDays),
  /** Days after a thread finished before its worktree is removed; read through `worktreeSweepOf`. */
  worktreeSweepRemoveDays: Schema.optionalKey(SweepDays),
  /**
   * The only MCP servers a Claude orchestrator loads beside Gram's own, each a server's name
   * or a URL pattern (how a claude.ai connector is named). Read through `orchestratorConnectors`;
   * with none listed, an orchestrator gets every server where tool search defers their schemas and
   * none where it doesn't, as on a gateway key.
   */
  orchestratorConnectors: Schema.optionalKey(Schema.Array(OrchestratorConnector)),
  /**
   * A Claude orchestrator may send to the user's Claude Code sessions outside Gram with Claude
   * Code's own `ListAgents` and `SendMessage`. Read through `orchestratorPeerMessaging`; absent, it
   * can't. No session Gram runs takes such a message in either way, and workers never send one.
   */
  orchestratorPeerMessaging: Schema.optionalKey(Schema.Boolean),
  /**
   * How many of Gram's own local checks run at once on this machine; the rest wait their turn.
   * Read through `localCheckConcurrencyOf`; absent, it follows the machine's cores.
   */
  localCheckConcurrency: Schema.optionalKey(LocalCheckConcurrency),
});
export type WorkspaceSettings = typeof WorkspaceSettings.Type;

const BudgetUsd = Schema.Finite.check(Schema.isGreaterThan(0));
const CallCap = Schema.Int.check(Schema.isGreaterThan(0));

export const VoiceSettings = Schema.Struct({
  /** The performance slider's stop, which picks the model. Read through `speechPerformanceOf`. */
  performance: Schema.optionalKey(SpeechPerformanceStop),
});
export type VoiceSettings = typeof VoiceSettings.Type;

export const HelperSettings = Schema.Struct({
  /** Absent means Automatic local subscriptions. */
  source: Schema.optionalKey(HelperSource),
  /** Explicit CLI model selections survive discovery changes; unavailable selections stop. */
  claudeModel: Schema.optionalKey(Schema.String),
  codexModel: Schema.optionalKey(Schema.String),
  /** Independent of Standard speed; absent requests High only when discovery supports it. */
  claudeEffort: Schema.optionalKey(ReasoningVariant),
  codexEffort: Schema.optionalKey(ReasoningVariant),
  /** Absent means automatic for Automatic source, none for explicit local sources. */
  localFallback: Schema.optionalKey(HelperLocalFallback),
  /** These never inherit the master switch or a gateway's endpoint-bound consent. */
  claudeContext: Schema.optionalKey(HelperContextScope),
  codexContext: Schema.optionalKey(HelperContextScope),
  /** The master switch for every helper-model call. Read through `helperOn`; absent means on. */
  enabled: Schema.optionalKey(Schema.Boolean),
  /** One switch per job kind, read through `helperOn` too; absent means on. */
  title: Schema.optionalKey(Schema.Boolean),
  plan: Schema.optionalKey(Schema.Boolean),
  recap: Schema.optionalKey(Schema.Boolean),
  suggest: Schema.optionalKey(Schema.Boolean),
  /** Waiting on you suggestions from a reply, and resolves from what the user writes. */
  wait: Schema.optionalKey(Schema.Boolean),
  /** Titles for asks' desktop notifications; the exact command stays under them. */
  notice: Schema.optionalKey(Schema.Boolean),
  /** "Why is it stuck?" on a worker that hasn't moved in a while. */
  stuck: Schema.optionalKey(Schema.Boolean),
  /** Historical gateway estimate limit only; never applies to subscription usage. */
  dailyBudgetUsd: Schema.optionalKey(BudgetUsd),
  /** Calls an hour may make. Read through `helperHourlyCalls`. */
  hourlyCalls: Schema.optionalKey(CallCap),
});
export type HelperSettings = typeof HelperSettings.Type;

export const helperSource = (settings: { readonly helpers?: HelperSettings }): HelperSource =>
  settings.helpers?.source ?? "automatic";

export const helperLocalFallback = (settings: {
  readonly helpers?: HelperSettings;
}): HelperLocalFallback =>
  settings.helpers?.localFallback ??
  (helperSource(settings) === "automatic" ? "automatic" : "none");

/** Authorizes only the named destination and scope. Opening permission covers titles alone. */
export const helperLocalContextAllowed = (
  settings: { readonly helpers?: HelperSettings },
  provider: "claude" | "codex",
  kind: HelperKind,
): boolean => {
  const scope = settings.helpers?.[provider === "claude" ? "claudeContext" : "codexContext"];
  return scope === "conversation" || (scope === "opening" && kind === "title");
};

/** Local CLI metadata history, per provider. Absent means on; false revokes it. */
export const UsageHistorySettings = Schema.Struct({
  claude: Schema.optionalKey(Schema.Boolean),
  codex: Schema.optionalKey(Schema.Boolean),
});
export type UsageHistorySettings = typeof UsageHistorySettings.Type;

export const usageHistoryEnabled = (
  settings: { readonly usageHistory?: UsageHistorySettings },
  provider: "claude" | "codex",
): boolean => settings.usageHistory?.[provider] !== false;

export const Settings = Schema.Struct({
  appearance: AppearanceSettings,
  sidebar: SidebarSettings,
  panel: PanelSettings,
  editor: EditorSettings,
  fonts: FontSettings,
  terminal: TerminalSettings,
  agents: AgentSettings,
  notifications: NotificationSettings,
  updates: UpdateSettings,
  onboarding: OnboardingSettings,
  logLevel: LogLevel,
  /** Absent until a layout field is set. */
  layout: Schema.optionalKey(LayoutSettings),
  /** Absent until set; read through `reviewBotsOf`, which falls back to the defaults. */
  reviewBots: Schema.optionalKey(Schema.Array(ReviewBot)),
  /** Absent until a composer setting is changed. */
  composer: Schema.optionalKey(ComposerSettings),
  /** Absent until the user has seen a PR's red build or change request. */
  attention: Schema.optionalKey(AttentionSettings),
  /** Absent until one of its switches is turned off or on. */
  experimental: Schema.optionalKey(ExperimentalSettings),
  /** Absent until one of its switches is turned off or on. */
  workspaces: Schema.optionalKey(WorkspaceSettings),
  /** Absent until a helper setting is changed. */
  helpers: Schema.optionalKey(HelperSettings),
  /** Absent until a speech model is chosen. */
  voice: Schema.optionalKey(VoiceSettings),
  /** Absent until something in the Inbox is snoozed or cleared. */
  inbox: Schema.optionalKey(InboxSettings),
  usageHistory: Schema.optionalKey(UsageHistorySettings),
});
export type Settings = typeof Settings.Type;

/**
 * The only MCP servers a Claude orchestrator keeps beside Gram's own, trimmed and without
 * blanks; empty when the user lists none, which leaves it the default (`mcpListsFor`).
 */
export const orchestratorConnectors = (settings: Settings): ReadonlyArray<string> =>
  (settings.workspaces?.orchestratorConnectors ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
/** Whether a Claude orchestrator may message the user's sessions outside Gram; off unless turned on. */
export const orchestratorPeerMessaging = (settings: Settings): boolean =>
  settings.workspaces?.orchestratorPeerMessaging === true;

/** The daily helper budget when the user set none. */
export const DEFAULT_HELPER_DAILY_BUDGET_USD = 2;

/** The hourly helper call cap when the user set none. */
export const DEFAULT_HELPER_HOURLY_CALLS = 400;

/** Whether helper jobs of `kind` may run: the master switch and the feature's, both on unless off. */
export const helperOn = (settings: Settings, kind: HelperKind): boolean =>
  settings.helpers?.enabled !== false && settings.helpers?.[kind] !== false;

export const helperDailyBudgetUsd = (settings: Settings): number =>
  settings.helpers?.dailyBudgetUsd ?? DEFAULT_HELPER_DAILY_BUDGET_USD;

export const helperHourlyCalls = (settings: Settings): number =>
  settings.helpers?.hourlyCalls ?? DEFAULT_HELPER_HOURLY_CALLS;

/** Whether a cut-off worker continues after restart: only when the user opted in. */
export const continueAfterRestart = (settings: Settings): boolean =>
  settings.workspaces?.continueAfterRestart ?? false;

/**
 * Gram's own local checks at once on a machine with `cores`: the saved choice, else one, or two
 * where there are twelve cores or more. A project's full check already runs its tests in parallel.
 */
export const localCheckConcurrencyOf = (settings: Settings, cores: number): number => {
  const chosen = settings.workspaces?.localCheckConcurrency;
  return chosen !== undefined && Number.isInteger(chosen) && chosen >= 1
    ? chosen
    : cores >= 12
      ? 2
      : 1;
};

export const DEFAULT_SWEEP_FREE_DAYS = 3;
export const DEFAULT_SWEEP_REMOVE_DAYS = 14;

/** When the worktree sweep takes each step, in days after a thread finished. */
export interface WorktreeSweep {
  readonly freeAfterDays: number;
  readonly removeAfterDays: number;
}

const sweepDays = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;

/**
 * The worktree sweep's schedule, `undefined` once turned off. On unless the user turned it off;
 * stored choices and validated day counts are preserved.
 */
export const worktreeSweepOf = (settings: Settings): WorktreeSweep | undefined => {
  const workspaces = settings.workspaces;
  if (workspaces?.worktreeSweep === false) return undefined;
  return {
    freeAfterDays: sweepDays(workspaces?.worktreeSweepFreeDays, DEFAULT_SWEEP_FREE_DAYS),
    removeAfterDays: sweepDays(workspaces?.worktreeSweepRemoveDays, DEFAULT_SWEEP_REMOVE_DAYS),
  };
};

/**
 * The mode orchestrators and their workers start in. They run unattended, so `auto` whatever the
 * user's default, except that a user who runs everything in `bypassPermissions` keeps that.
 */
export const orchestrationMode = (settings: Settings): PermissionMode =>
  settings.agents.defaultMode === "bypassPermissions" ? "bypassPermissions" : "auto";

/** Whether local voice input is on: off unless the user turned it on. */
export const voiceInputOn = (settings: Settings): boolean =>
  settings.experimental?.voiceInput === true;

/** The performance slider's stop: Balanced unless the user moved it. */
export const speechPerformanceOf = (settings: Settings): SpeechPerformanceStop =>
  settings.voice?.performance ?? "balanced";

/** The speech model the slider's stop runs. */
export const speechModelOf = (settings: Settings): SpeechModelId =>
  SPEECH_MODEL_FOR_STOP[speechPerformanceOf(settings)];

/** The configured review bots, else the defaults. */
export const reviewBotsOf = (settings: Settings): ReadonlyArray<ReviewBot> =>
  settings.reviewBots ?? DEFAULT_REVIEW_BOTS;

/** Where new Codex sessions get their executable; the user's own unless they chose otherwise. */
export const codexRuntimeOf = (settings: Settings): RuntimeSourceChoice =>
  settings.agents.codexRuntime ?? "path";

/** Whether a session restarts once idle after its agent's MCP config changes; on unless turned off. */
export const restartOnMcpChangeOn = (settings: Settings): boolean =>
  settings.agents.restartOnMcpChange !== false;

/** Whether to poll for PRs requesting the user's review; on unless turned off. */
export const reviewRequestsOn = (settings: Settings): boolean =>
  settings.notifications.reviewRequests !== false;

/** Whether to list only PRs requested from the user by name; on unless turned off. */
export const reviewRequestsDirectOnly = (settings: Settings): boolean =>
  settings.notifications.reviewRequestsDirectOnly !== false;

/** Whether to leave out PRs opened by a GitHub App; on unless turned off. */
export const reviewRequestsHideBots = (settings: Settings): boolean =>
  settings.notifications.reviewRequestsHideBots !== false;

/** Days of inactivity after which a PR is dropped; `undefined` means no cutoff. */
export const reviewRequestsMaxAgeDays = (settings: Settings): number | undefined => {
  const days = settings.notifications.reviewRequestsMaxAgeDays;
  return days !== undefined && Number.isInteger(days) && days > 0 ? days : undefined;
};

/** Whether a review request's notification waits for its checks to pass; off unless turned on. */
export const reviewRequestsAwaitChecks = (settings: Settings): boolean =>
  settings.notifications.reviewRequestsAwaitChecks === true;

/** Whether a review request's notification waits for a review bot; off unless turned on. */
export const reviewRequestsAwaitBot = (settings: Settings): boolean =>
  settings.notifications.reviewRequestsAwaitBot === true;

/** Whether an ask's desktop notification may carry Allow and Merge; on unless turned off. */
export const noticeActionsOn = (settings: Settings): boolean =>
  settings.notifications.actions !== false;

/** What may raise a desktop notification; asks and failures unless the user chose asks only. */
export const notifyAboutOf = (settings: Settings): NotifyAbout =>
  settings.notifications.notifyAbout ?? "asksAndFailures";

/** What a launch opens; the orchestrator used last unless the user chose the last thread. */
export const openAtLaunchOf = (settings: Settings): OpenAtLaunch =>
  settings.layout?.openAtLaunch ?? "orchestrator";

/** The overview sidebar as picked, `undefined` meaning automatic. */
export const overviewSidebarOf = (settings: Settings): OverviewSidebar | undefined =>
  settings.layout?.overviewSidebar;

/** The overview sidebar's optional sections that are turned off, in their order on screen. */
export const overviewHiddenOf = (settings: Settings): OverviewOptionalSection[] =>
  OVERVIEW_OPTIONAL_SECTIONS.filter(
    (section) =>
      !(
        settings.layout?.overviewSections?.[section] ??
        !OVERVIEW_HIDDEN_BY_DEFAULT.includes(section)
      ),
  );

/**
 * The stored form of the sections off: only what differs from the default, `false` for off and
 * `true` for on; `null` (cleared) when every section is at its default.
 */
export const overviewSectionsValue = (
  hidden: readonly OverviewOptionalSection[],
): OverviewSections | null => {
  const changed = OVERVIEW_OPTIONAL_SECTIONS.filter(
    (section) => hidden.includes(section) !== OVERVIEW_HIDDEN_BY_DEFAULT.includes(section),
  );
  return changed.length === 0
    ? null
    : Object.fromEntries(changed.map((section) => [section, !hidden.includes(section)]));
};

/** Whether the user muted desktop notifications for `workspaceId`'s asks. */
export const workspaceMuted = (settings: Settings, workspaceId: string): boolean =>
  settings.notifications.mutedWorkspaces?.includes(workspaceId) === true;

/** Whether `repo` is on `repos`, ignoring letter case as GitHub does. */
export const listsRepo = (repos: ReadonlyArray<string>, repo: string): boolean =>
  repos.some((listed) => listed.toLowerCase() === repo.toLowerCase());

/**
 * What a review request in `repo` waits for. The bot hold applies only to a repository the user says
 * has a review bot, so one without never holds a notification it could never release.
 */
export const reviewRequestHolds = (settings: Settings, repo: string): ReviewRequestHolds => {
  const repos = settings.notifications.reviewBotRepos;
  return {
    checks: reviewRequestsAwaitChecks(settings),
    bot: reviewRequestsAwaitBot(settings) && (repos === undefined || listsRepo(repos, repo)),
  };
};

/** Where new clones go when the user hasn't said; may contain `~`. */
export const DEFAULT_CLONE_FOLDER = "~/Documents/code";

/** The folder `projects.clone` puts a repository in, `~` unexpanded. */
export const cloneFolderOf = (settings: Settings): string =>
  settings.agents.cloneFolder ?? DEFAULT_CLONE_FOLDER;

/** The key that sends a message; plain Enter unless the user chose otherwise. */
export const sendKeyOf = (settings: Settings): SendKey => settings.composer?.sendKey ?? "enter";

/** The models the user added for `agent`, in the order they were added. */
export const customModelsOf = (settings: Settings, agent: AgentKind): ReadonlyArray<CustomModel> =>
  (settings.agents.customModels ?? []).filter((model) => model.agent === agent);

const partial = Struct.map(Schema.optionalKey);

/** A patch leaf for an optional setting: absent leaves it unchanged, `null` removes it. */
const clearable = <S extends Schema.Constraint>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

/**
 * A two-level patch for `settings.set`: any group, and any field within a group. An absent field is
 * unchanged; an optional field set to `null` is removed. Required fields can't be `null`.
 */
export const SettingsPatch = Schema.Struct({
  appearance: Schema.optionalKey(AppearanceSettings.mapFields(partial)),
  sidebar: Schema.optionalKey(SidebarSettings.mapFields(partial)),
  panel: Schema.optionalKey(
    Schema.Struct({
      side: Schema.optionalKey(Schema.Literals(["left", "right"])),
      open: Schema.optionalKey(Schema.Boolean),
      width: Schema.optionalKey(Schema.Int),
      tab: Schema.optionalKey(PanelTab),
    }),
  ),
  editor: Schema.optionalKey(Schema.Struct({ command: clearable(Schema.String) })),
  fonts: Schema.optionalKey(
    Schema.Struct({
      ui: clearable(Schema.String),
      mono: clearable(Schema.String),
      monoSize: clearable(Schema.Int),
    }),
  ),
  terminal: Schema.optionalKey(Schema.Struct({ shell: clearable(Schema.String) })),
  composer: Schema.optionalKey(Schema.Struct({ sendKey: Schema.optionalKey(SendKey) })),
  agents: Schema.optionalKey(
    Schema.Struct({
      defaultModel: clearable(ModelRef),
      /** Replaces the whole list. */
      customModels: Schema.optionalKey(Schema.Array(CustomModel)),
      defaultFolder: clearable(Schema.String),
      branchPrefix: clearable(Schema.String),
      cloneFolder: clearable(Schema.String),
      defaultMode: Schema.optionalKey(AgentSettings.fields.defaultMode),
      idleEvictMinutes: Schema.optionalKey(AgentSettings.fields.idleEvictMinutes),
      followWorktreeMoves: Schema.optionalKey(AgentSettings.fields.followWorktreeMoves),
      restartOnMcpChange: Schema.optionalKey(Schema.Boolean),
      /** Replaces the whole list. */
      workerModels: clearable(Schema.Array(WorkerModel)),
    }),
  ),
  notifications: Schema.optionalKey(
    Schema.Struct({
      native: Schema.optionalKey(NotificationSettings.fields.native),
      sounds: Schema.optionalKey(NotificationSettings.fields.sounds),
      chime: Schema.optionalKey(ChimeSound),
      reviewRequests: Schema.optionalKey(Schema.Boolean),
      reviewRequestsDirectOnly: Schema.optionalKey(Schema.Boolean),
      reviewRequestsHideBots: Schema.optionalKey(Schema.Boolean),
      reviewRequestsMaxAgeDays: clearable(MaxAgeDays),
      reviewRequestsAwaitChecks: Schema.optionalKey(Schema.Boolean),
      reviewRequestsAwaitBot: Schema.optionalKey(Schema.Boolean),
      /** Replaces the whole list. */
      reviewBotRepos: Schema.optionalKey(Schema.Array(Schema.String)),
      actions: Schema.optionalKey(Schema.Boolean),
      /** Replaces the whole list. */
      mutedWorkspaces: Schema.optionalKey(Schema.Array(Schema.String)),
      notifyAbout: clearable(NotifyAbout),
    }),
  ),
  updates: Schema.optionalKey(
    Schema.Struct({
      channel: Schema.optionalKey(UpdateSettings.fields.channel),
      automaticChecks: Schema.optionalKey(Schema.Boolean),
      pinnedVersion: clearable(Schema.String),
    }),
  ),
  onboarding: Schema.optionalKey(
    Schema.Struct({
      lastSeenVersion: clearable(Schema.String),
      welcomeSeen: Schema.optionalKey(OnboardingSettings.fields.welcomeSeen),
      dismissedLaunchIssues: clearable(Schema.Array(Schema.String)),
      gatewayOfferDismissed: Schema.optionalKey(Schema.Boolean),
      workspaceGuideSeen: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  layout: Schema.optionalKey(
    Schema.Struct({
      grid: clearable(GridLayout),
      focusMode: clearable(Schema.Boolean),
      quietWhenIdle: clearable(Schema.Boolean),
      openAtLaunch: clearable(OpenAtLaunch),
      overviewSidebar: clearable(OverviewSidebar),
      /** Replaces the whole set; `null` shows every section again. */
      overviewSections: clearable(OverviewSections),
    }),
  ),
  logLevel: Schema.optionalKey(LogLevel),
  /** Replaces the whole list. */
  reviewBots: Schema.optionalKey(Schema.Array(ReviewBot)),
  attention: Schema.optionalKey(
    Schema.Struct({
      acknowledged: Schema.optionalKey(AttentionSettings.fields.acknowledged),
    }),
  ),
  experimental: Schema.optionalKey(
    Schema.Struct({ voiceInput: Schema.optionalKey(ExperimentalSettings.fields.voiceInput) }),
  ),
  usageHistory: Schema.optionalKey(UsageHistorySettings),
  workspaces: Schema.optionalKey(WorkspaceSettings),
  helpers: Schema.optionalKey(
    Schema.Struct({
      source: clearable(HelperSource),
      claudeModel: clearable(Schema.String),
      codexModel: clearable(Schema.String),
      claudeEffort: clearable(ReasoningVariant),
      codexEffort: clearable(ReasoningVariant),
      localFallback: clearable(HelperLocalFallback),
      claudeContext: clearable(HelperContextScope),
      codexContext: clearable(HelperContextScope),
      enabled: clearable(Schema.Boolean),
      title: clearable(Schema.Boolean),
      plan: clearable(Schema.Boolean),
      recap: clearable(Schema.Boolean),
      suggest: clearable(Schema.Boolean),
      wait: clearable(Schema.Boolean),
      notice: clearable(Schema.Boolean),
      stuck: clearable(Schema.Boolean),
      dailyBudgetUsd: clearable(BudgetUsd),
      hourlyCalls: clearable(CallCap),
    }),
  ),
  voice: Schema.optionalKey(
    Schema.Struct({
      performance: clearable(SpeechPerformanceStop),
    }),
  ),
  inbox: Schema.optionalKey(
    Schema.Struct({
      /** Replaces the whole list. */
      snoozed: Schema.optionalKey(InboxSettings.fields.snoozed),
      /** Replaces the whole list. */
      cleared: Schema.optionalKey(InboxSettings.fields.cleared),
    }),
  ),
});
export type SettingsPatch = typeof SettingsPatch.Type;

/** The settings paths `applySettingsPatch` sets or clears for `patch`: a section's fields, or a top-level key. */
export const settingsPatchPaths = (patch: SettingsPatch): ReadonlyArray<ReadonlyArray<string>> =>
  Object.entries(patch).flatMap(([key, value]) =>
    typeof value !== "object" || value === null || Array.isArray(value)
      ? [[key]]
      : Object.keys(value).map((leaf) => [key, leaf]),
  );

export const applySettingsPatch = (settings: Settings, patch: SettingsPatch): Settings => {
  const next: Record<string, unknown> = { ...settings };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      next[key] = value;
      continue;
    }
    const merged: Record<string, unknown> = {
      ...(next[key] as object | undefined),
      ...value,
    };
    next[key] = Object.fromEntries(Object.entries(merged).filter(([, leaf]) => leaf !== null));
  }
  return next as Settings;
};

export const DEFAULT_SETTINGS: Settings = Schema.decodeSync(Settings)({
  appearance: {
    look: "glass",
    paletteId: "neutral-dark",
    mode: "dark",
    density: "comfortable",
    contrast: "standard",
    motion: "system",
  },
  sidebar: {
    grouping: "status",
    width: 248,
    collapsed: false,
    collapsedGroups: [],
  },
  panel: { side: "right", open: true, width: 352, tab: "diff" },
  editor: {},
  fonts: {},
  terminal: {},
  agents: {
    defaultMode: "auto",
    idleEvictMinutes: 15,
    followWorktreeMoves: true,
  },
  notifications: { native: true, sounds: true },
  updates: { channel: "stable" },
  onboarding: { welcomeSeen: false },
  logLevel: "info",
  reviewBots: DEFAULT_REVIEW_BOTS,
});
