import type { ExperimentalSettings, Settings } from "@gram/contracts";
import {
  Bell,
  Bot,
  Ellipsis,
  Network,
  SlidersHorizontal,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { AgentChecks } from "@/launch-checks/tool-checks";
import { useServerSettings } from "@/settings-sync/store";

import {
  ReviewBotsSummary,
  SubpageList,
  SubpageRow,
  TerminalSummary,
  UpdateDot,
  useUpdateAvailable,
} from "./advanced-page";
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
import { DiagnosticsSection } from "./diagnostics-section";
import { EditorSection } from "./editor-section";
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
   * Which of the six groups the page belongs to. The page whose id is the group's is the group
   * itself; the rest open from it, such as Advanced → Gateways.
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
  /**
   * The experimental switch the page's feature is behind: listed, and searched, only while it is
   * on. Settings → Diagnostics holds the switch meanwhile.
   */
  readonly experimental?: keyof ExperimentalSettings;
}

/** The six groups the nav lists; each is a page of its own, and Advanced opens the rest. */
export type SettingsGroupId =
  | "general"
  | "agents"
  | "workspaces"
  | "appearance"
  | "notifications"
  | "advanced";

export interface SettingsNavGroup {
  readonly id: SettingsGroupId;
  readonly label: string;
  readonly path: SettingsPath;
  readonly icon: LucideIcon;
}

/** The nav, in order. */
export const SETTINGS_GROUPS: readonly SettingsNavGroup[] = [
  { id: "general", label: "General", path: "/settings/general", icon: SlidersHorizontal },
  { id: "agents", label: "Agents", path: "/settings/agents", icon: Bot },
  { id: "workspaces", label: "Workspaces", path: "/settings/workspaces", icon: Network },
  { id: "appearance", label: "Appearance", path: "/settings/appearance", icon: Sun },
  { id: "notifications", label: "Notifications", path: "/settings/notifications", icon: Bell },
  { id: "advanced", label: "Advanced", path: "/settings/advanced", icon: Ellipsis },
];

/** The group a page sits in, by the group's id. */
export const settingsGroupOf = (page: Pick<SettingsPage, "group">): SettingsNavGroup =>
  SETTINGS_GROUPS.find((group) => group.id === page.group)!;

/** Whether `page` opens from its group rather than being the group's own page. */
export const isSubpage = (page: Pick<SettingsPage, "id" | "group">): boolean =>
  page.id !== page.group;

type SettingsPath =
  | "/settings/general"
  | "/settings/notifications"
  | "/settings/terminal"
  | "/settings/agents"
  | "/settings/gateways"
  | "/settings/ai-helpers"
  | "/settings/connectors"
  | "/settings/review-bots"
  | "/settings/workspaces"
  | "/settings/appearance"
  | "/settings/keyboard"
  | "/settings/voice-input"
  | "/settings/storage"
  | "/settings/updates"
  | "/settings/diagnostics"
  | "/settings/help"
  | "/settings/advanced";

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
        description="The editor Open in editor launches: a preset, or your own command."
        keywords={EDITOR_KEYWORDS}
      >
        <EditorSection />
      </SettingsGroup>
      <SettingsGroup
        label="Trusted links"
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

/**
 * Settings → Advanced: a row for each page that opens from it, and Experimental, whose switches
 * sit on Diagnostics.
 */
export function AdvancedPage() {
  const settings = useServerSettings((s) => s.settings);
  const updateAvailable = useUpdateAvailable();
  const pages = listedSettingsPages(SETTINGS_PAGES, settings).filter(
    (page) => page.group === "advanced" && isSubpage(page),
  );
  return (
    <SubpageList>
      {pages.map((page) => {
        const Summary = page.summary;
        return (
          <SubpageRow
            key={page.id}
            label={page.label}
            to={page.path}
            summary={Summary && <Summary />}
            badge={page.id === "updates" && updateAvailable ? <UpdateDot /> : undefined}
          />
        );
      })}
      <SubpageRow
        label="Experimental"
        to="/settings/diagnostics"
        search={{ highlight: "experimental" }}
      />
    </SubpageList>
  );
}

/** Settings → Updates, wired to the persisted channel, opt-ins and version pin. */
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

/** Every tab, in nav order, which is also the order Settings search lists them in. */
export const ALL_SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: "general",
    label: "General",
    path: "/settings/general",
    group: "general",
    description: "New threads, sending, your editor, and links that open without asking.",
    search: GeneralPage,
    defaults: Object.values(GENERAL_DEFAULTS),
  },
  {
    id: "agents",
    label: "Agents",
    path: "/settings/agents",
    group: "agents",
    description: "Whether each agent is ready, what a new thread runs on, models the pickers add.",
    search: AgentsPage,
    defaults: Object.values(AGENTS_DEFAULTS),
  },
  {
    id: "workspaces",
    label: "Workspaces",
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
    ],
    search: WorkspacesSettings,
  },
  {
    id: "appearance",
    label: "Appearance",
    path: "/settings/appearance",
    group: "appearance",
    description: "Mode, palette, density, motion and fonts, with a live preview.",
    search: AppearanceSearch,
    wide: true,
  },
  {
    id: "notifications",
    label: "Notifications",
    path: "/settings/notifications",
    group: "notifications",
    description: "When Gram tells you a thread needs you, and which review requests it lists.",
    search: NotificationsSection,
    defaults: Object.values(NOTIFICATIONS_DEFAULTS),
  },
  {
    id: "advanced",
    label: "Advanced",
    path: "/settings/advanced",
    group: "advanced",
    description: "Gateways, helpers, connectors, storage, keys and the rest.",
    keywords: ["experimental", "more"],
    search: null,
  },
  {
    id: "gateways",
    label: "Gateways",
    path: "/settings/gateways",
    group: "advanced",
    description:
      "Optional OpenAI-compatible gateways, such as LiteLLM. Local agents use their own accounts.",
    keywords: ["litellm", "openai", "api key", "provider", "base url", "profile"],
    search: null,
  },
  {
    id: "ai-helpers",
    label: "AI helpers",
    path: "/settings/ai-helpers",
    group: "advanced",
    description: "The model for small background jobs, run on your installed CLI and its login.",
    keywords: ["helper model", "luna", "haiku", "fallback", "budget", "cost", "usage", "privacy"],
    search: AiHelpersSection,
    defaults: Object.values(AI_HELPERS_DEFAULTS),
  },
  {
    id: "connectors",
    label: "Connectors",
    path: "/settings/connectors",
    group: "advanced",
    description:
      "Each agent's own MCP servers and sign-ins, read from its config. Gram stores neither.",
    keywords: ["mcp", "servers", "sign in", "oauth", "tools"],
    search: null,
  },
  {
    id: "review-bots",
    label: "Review bots",
    path: "/settings/review-bots",
    group: "advanced",
    description:
      "Reviewers whose rounds and findings show on a PR. Logins match in any case; * is a wildcard.",
    keywords: ["reviewer", "login", "re-review", "approve", "pull request"],
    search: ReviewBotsSection,
    summary: ReviewBotsSummary,
  },
  {
    id: "storage",
    label: "Storage",
    path: "/settings/storage",
    group: "advanced",
    description: "Worktrees across your repos, what they take on disk, and cleanup.",
    keywords: ["worktrees", "disk", "space", "clean up", "prune", "node_modules", "sweep"],
    search: null,
  },
  {
    id: "keyboard",
    label: "Keyboard",
    path: "/settings/keyboard",
    group: "advanced",
    description:
      "Every shortcut, with custom ones and clashes marked. Record new keys or reset them.",
    keywords: ["shortcuts", "keybindings", "hotkeys", "rebind", "keybindings.json"],
    search: KeyboardSection,
  },
  {
    id: "terminal",
    label: "Terminal",
    path: "/settings/terminal",
    group: "advanced",
    description: "The shell the Terminal tab starts.",
    keywords: ["shell", "powershell", "pwsh", "cmd", "git bash"],
    search: TerminalSection,
    summary: TerminalSummary,
    defaults: Object.values(TERMINAL_DEFAULTS),
    windowsOnly: true,
  },
  {
    id: "voice-input",
    label: "Voice input",
    path: "/settings/voice-input",
    group: "advanced",
    description:
      "Dictate into the composer, recognised on this computer or by an optional gateway.",
    keywords: [
      "dictation",
      "speech",
      "microphone",
      "mic",
      "transcribe",
      "voice",
      "nemotron",
      "whisper",
    ],
    search: VoiceInputSection,
    experimental: "voiceInput",
  },
  {
    id: "updates",
    label: "Updates",
    path: "/settings/updates",
    group: "advanced",
    description: "Check for new releases, download them and restart into them.",
    keywords: ["version", "release", "upgrade", "pin"],
    search: UpdatesPage,
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    path: "/settings/diagnostics",
    group: "advanced",
    description: "Versions, paths, the tools Gram found, and the logs.",
    keywords: ["logs", "version", "troubleshooting", "debug", "trace"],
    search: DiagnosticsSection,
    defaults: Object.values(DIAGNOSTICS_DEFAULTS),
  },
  {
    id: "help",
    label: "What's New",
    path: "/settings/help",
    group: "advanced",
    description: "Each release's highlights, the What's New screen again, and acknowledgements.",
    keywords: [
      "help",
      "release notes",
      "changelog",
      "documentation",
      "acknowledgements",
      "licenses",
      "third-party notices",
    ],
    search: HelpSection,
  },
];

/**
 * The tabs this platform shows. Browser dev has no `platform` and shows every tab, so the Windows
 * ones can be tried on a Mac.
 */
export function settingsPagesFor(platform: string | undefined): readonly SettingsPage[] {
  return platform === undefined || platform === "win32"
    ? ALL_SETTINGS_PAGES
    : ALL_SETTINGS_PAGES.filter((page) => page.windowsOnly !== true);
}

export const SETTINGS_PAGES = settingsPagesFor(
  typeof window === "undefined" ? undefined : window.gram?.platform,
);

/** Settings pages whose experimental switch is on, plus the always-offered pages. */
export const listedSettingsPages = (
  pages: readonly SettingsPage[],
  settings: Settings | undefined,
): readonly SettingsPage[] =>
  pages.filter(
    (page) =>
      page.experimental === undefined || settings?.experimental?.[page.experimental] === true,
  );

const LAST_PAGE_KEY = "gram.settings.page";

/** The page among `pages` an id names. */
export function settingsPageById(
  id: string | null,
  pages: readonly SettingsPage[] = SETTINGS_PAGES,
): SettingsPage | undefined {
  if (id === null) return undefined;
  return pages.find((page) => page.id === id);
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
