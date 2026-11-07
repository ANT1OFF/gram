import {
  Bell,
  Bot,
  Gauge,
  Info,
  Keyboard,
  Mic,
  Network,
  SlidersHorizontal,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { AgentChecks } from "@/launch-checks/tool-checks";
import { useServerSettings } from "@/settings-sync/store";

import {
  AiHelpersSummary,
  GatewaysSummary,
  ReviewBotsSummary,
  RoutinesSummary,
  TerminalSummary,
} from "./subpages";
import { AiHelpersSection } from "./ai-helpers-section";
import { AgentsSection } from "./agents-section";
import { AppearanceSearch } from "./appearance-section";
import { CustomModelsSection } from "./custom-models-section";
import {
  AGENTS_DEFAULTS,
  AI_HELPERS_DEFAULTS,
  DIAGNOSTICS_DEFAULTS,
  GENERAL_DEFAULTS,
  NOTIFICATIONS_DEFAULTS,
  TERMINAL_DEFAULTS,
  type DefaultSetting,
} from "./defaults";
import { DiagnosticsSection, InstallInfo } from "./diagnostics-section";
import { EditorSection } from "./editor-section";
import { GENERAL_ANCHORS, GENERAL_SECTIONS, type SettingsAnchor } from "./general-anchors";
import { GeneralSection } from "./general-section";
import { HelpSection } from "./help-section";
import { KeyboardSection } from "./keyboard-section";
import { NotificationsSection } from "./notifications-section";
import { ReviewBotsSection } from "./review-bots-section";
import { SearchScope } from "./search-scope";
import { SettingsGroup } from "./settings-group";
import { TerminalSection } from "./terminal-section";
import { AgentBrowseSection } from "./agent-browse-section";
import { TrustedLinksSection } from "./trusted-links-section";
import { UpdatesSection } from "./updates-section";
import { useFeature } from "./use-diagnostics";
import { VoiceInputSection } from "./voice-input-section";
import { useSaveSettings } from "./use-save-settings";
import { WorkspacesSettings } from "./workspace-settings";

/** One Settings tab: its own route, its heading and what Settings search finds it by. */
export interface SettingsPage {
  readonly id: string;
  readonly label: string;
  readonly path: SettingsPath;
  /**
   * Which of the groups the page belongs to. The page whose id is the group's is the group
   * itself; the rest open from it, such as Agents & models → Gateways.
   */
  readonly group: SettingsGroupId;
  /** What the page is for, behind the heading's ? and read by Settings search. */
  readonly description: string;
  /** A short value for the page's row in its group, such as a count. */
  readonly summary?: ComponentType;
  /** Words that find the whole page, beyond its label. */
  readonly keywords?: readonly string[];
  /**
   * What Settings search holds of the page while another page is open, its settings matched one by
   * one. `null` for a page that isn't built from settings: a search finds it by name and keywords
   * alone, and shows its heading and description.
   */
  readonly search: ComponentType | null;
  /** What the page's Restore defaults resets; a page without it has none. */
  readonly defaults?: readonly DefaultSetting[];
  /** Beside the heading. */
  readonly actions?: ComponentType;
  /** Wider than a thread, for a page with a preview beside its controls. */
  readonly wide?: boolean;
  /** Only on Windows, where the page has a setting; elsewhere its route opens General. */
  readonly windowsOnly?: boolean;
}

/** The groups the nav lists; each is a page of its own, and some open a few more. */
export type SettingsGroupId =
  | "general"
  | "agents"
  | "usage"
  | "workspaces"
  | "appearance"
  | "notifications"
  | "keyboard"
  | "voice-input"
  | "about";

export interface SettingsNavGroup {
  readonly id: SettingsGroupId;
  readonly label: string;
  readonly path: SettingsPath;
  readonly icon: LucideIcon;
  /** The page's own subsections, linked under it in the nav while it is open. */
  readonly sections?: readonly SettingsAnchor[];
}

/** The nav, in order. */
export const SETTINGS_GROUPS: readonly SettingsNavGroup[] = [
  {
    id: "general",
    label: "General",
    path: "/settings/general",
    icon: SlidersHorizontal,
    sections: GENERAL_SECTIONS,
  },
  { id: "agents", label: "Agents & models", path: "/settings/agents", icon: Bot },
  { id: "usage", label: "Usage", path: "/settings/usage", icon: Gauge },
  {
    id: "workspaces",
    label: "Workspaces & merging",
    path: "/settings/workspaces",
    icon: Network,
  },
  { id: "appearance", label: "Appearance", path: "/settings/appearance", icon: Sun },
  { id: "notifications", label: "Notifications", path: "/settings/notifications", icon: Bell },
  { id: "keyboard", label: "Keyboard", path: "/settings/keyboard", icon: Keyboard },
  { id: "voice-input", label: "Voice", path: "/settings/voice-input", icon: Mic },
  { id: "about", label: "About", path: "/settings/about", icon: Info },
];

/** The group a page sits in, by the group's id. */
export const settingsGroupOf = (page: Pick<SettingsPage, "group">): SettingsNavGroup =>
  SETTINGS_GROUPS.find((group) => group.id === page.group)!;

/** Whether `page` opens from its group rather than being the group's own page. */
export const isSubpage = (page: Pick<SettingsPage, "id" | "group">): boolean =>
  page.id !== page.group;

/** The pages that open from `group`, in nav order. */
export const subpagesOf = (
  group: SettingsGroupId,
  pages: readonly SettingsPage[] = SETTINGS_PAGES,
): readonly SettingsPage[] => pages.filter((page) => page.group === group && isSubpage(page));

export type SettingsPath =
  | "/settings/general"
  | "/settings/notifications"
  | "/settings/terminal"
  | "/settings/agents"
  | "/settings/gateways"
  | "/settings/ai-helpers"
  | "/settings/connectors"
  | "/settings/review-bots"
  | "/settings/routines"
  | "/settings/usage"
  | "/settings/workspaces"
  | "/settings/appearance"
  | "/settings/keyboard"
  | "/settings/voice-input"
  | "/settings/storage"
  | "/settings/about"
  | "/settings/diagnostics"
  | "/settings/help";

/**
 * Search words for the parts of a page that aren't built from `Field`s, which bring their own label
 * and description. Words the heading already has don't need repeating.
 */
const EDITOR_KEYWORDS = ["vs code", "vscode", "cursor", "zed", "command", "path", "line"];
const CUSTOM_MODEL_KEYWORDS = ["model id", "reasoning effort"];
const TRUSTED_LINK_KEYWORDS = ["link", "domain", "host", "url", "browser", "open external"];
const AGENT_BROWSE_KEYWORDS = ["browse", "browser", "preview", "host", "site", "domain", "agent"];

/**
 * Settings → General: new-thread defaults, layout, the editor files open in, trusted links and the
 * hosts agents may browse.
 */
export function GeneralPage() {
  const agentBrowsing = useFeature("agentBrowsingPublic", { settled: true });
  return (
    <>
      <SearchScope label="General">
        <GeneralSection />
      </SearchScope>
      <SettingsGroup
        label="Open in editor"
        anchor={GENERAL_ANCHORS.editor}
        description="The editor Open in editor launches: a preset, or your own command."
        keywords={EDITOR_KEYWORDS}
      >
        <EditorSection />
      </SettingsGroup>
      <SettingsGroup
        label="Trusted links"
        anchor={GENERAL_ANCHORS.links}
        card={false}
        description="Links to these hosts open in your browser without asking."
        learnMore={
          <p>
            Tick &ldquo;Always open links to…&rdquo; in the link dialog to add one. Only https links
            on the usual port skip the question; anything else, or a link with a user name before
            the host, still asks.
          </p>
        }
        keywords={TRUSTED_LINK_KEYWORDS}
      >
        <TrustedLinksSection />
      </SettingsGroup>
      {agentBrowsing && (
        <SettingsGroup
          label="Agent may browse"
          card={false}
          description="Public sites agents may open in the Preview pane without asking."
          learnMore={
            <p>
              Trusted links count too. &ldquo;Always for this host&rdquo; on an agent&rsquo;s
              request adds one. Submitting a form still asks every time; private-network and sign-in
              pages are restricted.
            </p>
          }
          keywords={AGENT_BROWSE_KEYWORDS}
        >
          <AgentBrowseSection />
        </SettingsGroup>
      )}
    </>
  );
}

/** Settings → Agents: each agent's status, new-thread defaults, custom models. */
export function AgentsPage() {
  return (
    <>
      <AgentChecks />
      <AgentsSection />
      <SettingsGroup
        label="Custom models"
        card={false}
        description={
          <>
            Models an agent doesn&apos;t list itself, such as{" "}
            <code className="font-mono">opus[1m]</code>. Pickers offer them after its own.
          </>
        }
        learnMore={
          <p>
            The id is sent to the agent as written. Context size and cost are whatever the agent
            reports once the thread runs.
          </p>
        }
        keywords={CUSTOM_MODEL_KEYWORDS}
      >
        <CustomModelsSection />
      </SettingsGroup>
    </>
  );
}

/** Settings → About → Updates, wired to the persisted channel, opt-ins and version pin. */
export function UpdatesPage() {
  const updates = useServerSettings((s) => s.settings?.updates);
  const channel = updates?.channel;
  const pinnedVersion = useServerSettings((s) => s.settings?.updates.pinnedVersion);
  const saveSettings = useSaveSettings();
  return (
    <UpdatesSection
      channel={channel}
      automaticChecks={updates?.automaticChecks === true}
      onPreferencesChange={(patch) => saveSettings({ updates: patch })}
      pinnedVersion={pinnedVersion}
      onPinChange={(pin) => saveSettings({ updates: { pinnedVersion: pin } })}
    />
  );
}

const UPDATE_KEYWORDS = ["version", "release", "upgrade", "pin", "channel", "download", "restart"];

/** Settings → About: which version this is, and its updates. */
export function AboutPage() {
  return (
    <>
      <InstallInfo />
      <SettingsGroup
        label="Updates"
        card={false}
        description="Check for new releases, download them and restart into them."
        keywords={UPDATE_KEYWORDS}
      >
        <UpdatesPage />
      </SettingsGroup>
    </>
  );
}

/** Every tab, in nav order, which is also the order Settings search lists them in. */
export const ALL_SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: "general",
    label: "General",
    path: "/settings/general",
    group: "general",
    description: "Launch, branches, the composer, running work, your editor and links.",
    keywords: ["preferences", "startup", "folders"],
    search: GeneralPage,
    defaults: Object.values(GENERAL_DEFAULTS),
  },
  {
    id: "agents",
    label: "Agents & models",
    path: "/settings/agents",
    group: "agents",
    description: "Whether each agent is ready, what a new thread runs on, models the pickers add.",
    keywords: ["agents", "models", "claude", "codex", "cli"],
    search: AgentsPage,
    defaults: Object.values(AGENTS_DEFAULTS),
  },
  {
    id: "ai-helpers",
    label: "AI helpers",
    path: "/settings/ai-helpers",
    group: "agents",
    description: "The model for small background jobs, run on your installed CLI and its login.",
    keywords: [
      "helper model",
      "luna",
      "haiku",
      "fallback",
      "budget",
      "cost",
      "usage",
      "privacy",
      "titles",
      "summaries",
      // "advanced": where this and the other pages it held lived, so the old way there finds them.
      "advanced",
    ],
    search: AiHelpersSection,
    summary: AiHelpersSummary,
    defaults: Object.values(AI_HELPERS_DEFAULTS),
  },
  {
    id: "connectors",
    label: "Connectors",
    path: "/settings/connectors",
    group: "agents",
    description:
      "Each agent's own MCP servers and sign-ins, read from its config. Gram stores neither.",
    keywords: [
      "mcp",
      "servers",
      "sign in",
      "oauth",
      "tools",
      "integrations",
      "plugins",
      "advanced",
    ],
    search: null,
  },
  {
    id: "gateways",
    label: "Gateways",
    path: "/settings/gateways",
    group: "agents",
    description:
      "Optional OpenAI-compatible gateways, such as LiteLLM. Local agents use their own accounts.",
    keywords: [
      "litellm",
      "openai",
      "api key",
      "provider",
      "base url",
      "profile",
      "proxy",
      "endpoint",
      "advanced",
    ],
    search: null,
    summary: GatewaysSummary,
  },
  {
    id: "usage",
    label: "Usage",
    path: "/settings/usage",
    group: "usage",
    description:
      "Each subscription's limits, how fast they fill, Codex credits, and 7 or 30 days of history.",
    keywords: [
      "limits",
      "rate limit",
      "quota",
      "5-hour",
      "weekly",
      "reset",
      "pace",
      "credits",
      "history",
      "subscription",
      "plan",
    ],
    search: null,
    wide: true,
  },
  {
    id: "workspaces",
    label: "Workspaces & merging",
    path: "/settings/workspaces",
    group: "workspaces",
    description: "Repositories one orchestrator works on together, and how far it goes unasked.",
    // "experimental": where this lived until 0.7, so the old way there still finds it.
    keywords: [
      "experimental",
      "orchestrator",
      "orchestration",
      "worker",
      "charter",
      "pull requests",
      "merge",
      "repositories",
    ],
    search: WorkspacesSettings,
  },
  {
    id: "routines",
    label: "Routines",
    path: "/settings/routines",
    group: "workspaces",
    description:
      "Every workspace's briefs that start a worker or wake the orchestrator on a schedule.",
    keywords: [
      "routine",
      "schedule",
      "scheduled",
      "recurring",
      "cron",
      "daily",
      "weekly",
      "nightly",
      "every few hours",
      "run now",
    ],
    search: null,
    summary: RoutinesSummary,
  },
  {
    id: "review-bots",
    label: "Review bots",
    path: "/settings/review-bots",
    group: "workspaces",
    description:
      "Reviewers whose rounds and findings show on a PR. Logins match in any case; * is a wildcard.",
    keywords: [
      "reviewer",
      "login",
      "re-review",
      "approve",
      "pull request",
      "code review",
      "advanced",
    ],
    search: ReviewBotsSection,
    summary: ReviewBotsSummary,
  },
  {
    id: "storage",
    label: "Storage",
    path: "/settings/storage",
    group: "workspaces",
    description: "Worktrees across your repos, what they take on disk, and cleanup.",
    keywords: [
      "worktrees",
      "disk",
      "space",
      "clean up",
      "cleanup",
      "prune",
      "node_modules",
      "sweep",
      "advanced",
    ],
    search: null,
  },
  {
    id: "appearance",
    label: "Appearance",
    path: "/settings/appearance",
    group: "appearance",
    description: "Mode, palette, density, motion, transcript size and width, and fonts.",
    // Not "dark" or "light": the Mode row answers those itself, and a page word shows every row.
    keywords: ["theme", "colours", "colors", "look"],
    search: AppearanceSearch,
    wide: true,
  },
  {
    id: "terminal",
    label: "Terminal",
    path: "/settings/terminal",
    group: "appearance",
    description: "The shell the Terminal tab starts.",
    keywords: ["shell", "powershell", "pwsh", "cmd", "git bash", "console", "advanced"],
    search: TerminalSection,
    summary: TerminalSummary,
    defaults: Object.values(TERMINAL_DEFAULTS),
    windowsOnly: true,
  },
  {
    id: "notifications",
    label: "Notifications",
    path: "/settings/notifications",
    group: "notifications",
    description: "When Gram interrupts you, how, and which review requests it lists.",
    keywords: ["alerts", "sounds", "interruptions", "quiet", "do not disturb"],
    search: NotificationsSection,
    defaults: Object.values(NOTIFICATIONS_DEFAULTS),
  },
  {
    id: "keyboard",
    label: "Keyboard",
    path: "/settings/keyboard",
    group: "keyboard",
    description:
      "Every shortcut, with custom ones and clashes marked. Record new keys or reset them.",
    keywords: [
      "shortcuts",
      "keybindings",
      "key bindings",
      "hotkeys",
      "rebind",
      "keybindings.json",
      "advanced",
    ],
    search: KeyboardSection,
  },
  {
    id: "voice-input",
    label: "Voice",
    path: "/settings/voice-input",
    group: "voice-input",
    description: "Dictate into the composer, recognised on this computer, with a key to talk.",
    keywords: [
      "voice input",
      "dictation",
      "dictate",
      "speech",
      "microphone",
      "mic",
      "transcribe",
      "push to talk",
      "hotkey",
      "nemotron",
      "parakeet",
      // Where its switch lived until 1.5, so the old way there still finds it.
      "experimental",
    ],
    search: VoiceInputSection,
  },
  {
    id: "about",
    label: "About",
    path: "/settings/about",
    group: "about",
    description: "Which version this is, and its updates.",
    keywords: ["updates", "version", "release", "upgrade", "pin", "advanced"],
    search: AboutPage,
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    path: "/settings/diagnostics",
    group: "about",
    description: "Where Gram keeps its data, the tools it found, and the logs.",
    keywords: ["logs", "troubleshooting", "debug", "trace", "support", "bug report", "advanced"],
    search: DiagnosticsSection,
    defaults: Object.values(DIAGNOSTICS_DEFAULTS),
  },
  {
    id: "help",
    label: "What's New",
    path: "/settings/help",
    group: "about",
    description: "Each release's highlights, the What's New screen again, and acknowledgements.",
    keywords: [
      "help",
      "release notes",
      "changelog",
      "documentation",
      "acknowledgements",
      "licenses",
      "third-party notices",
      "advanced",
    ],
    search: HelpSection,
  },
];

/**
 * The tabs this platform shows. Browser dev has no `platform` and shows every tab, so the Windows
 * ones can be tried on a Mac.
 */
export function settingsPagesFor(platform: string | undefined): readonly SettingsPage[] {
  return ALL_SETTINGS_PAGES.filter(
    (page) => platform === undefined || platform === "win32" || page.windowsOnly !== true,
  );
}

export const SETTINGS_PAGES = settingsPagesFor(
  typeof window === "undefined" ? undefined : window.gram?.platform,
);

/**
 * Where an old `/settings/advanced` link goes: the page a `/settings/advanced/<id>` names, by its
 * id or its old one, else General.
 */
export function advancedRedirect(pathname: string): SettingsPath {
  const id = pathname.replace(/^\/settings\/advanced\/?/, "").split("/")[0] ?? "";
  return settingsPageById(id === "" ? null : id, ALL_SETTINGS_PAGES)?.path ?? "/settings/general";
}

const LAST_PAGE_KEY = "gram.settings.page";

/** Pages that were renamed, by their old id, so a remembered one still opens. */
const RENAMED_PAGES: Readonly<Record<string, string>> = { updates: "about" };

/** The page among `pages` an id names. */
export function settingsPageById(
  id: string | null,
  pages: readonly SettingsPage[] = SETTINGS_PAGES,
): SettingsPage | undefined {
  if (id === null) return undefined;
  const current = RENAMED_PAGES[id] ?? id;
  return pages.find((page) => page.id === current);
}

/** The tab Settings opened on last, where ⌘, lands; General the first time. */
export function lastSettingsPage(): SettingsPage {
  let id: string | null = null;
  try {
    id = localStorage.getItem(LAST_PAGE_KEY);
  } catch {
    // Storage can be off (a locked-down browser); Settings then always opens on General.
  }
  return settingsPageById(id) ?? SETTINGS_PAGES[0]!;
}

export function rememberSettingsPage(id: string): void {
  try {
    localStorage.setItem(LAST_PAGE_KEY, id);
  } catch {
    // As above: without storage, nothing is remembered.
  }
}
