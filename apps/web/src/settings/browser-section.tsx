import {
  browserAppProblem,
  browserSiteProblem,
  browserUseAllowed,
  codexSurfaces,
  type AgentKind,
  type CodexSurfaces,
  type SettingsPatch,
} from "@gram/contracts";
import { useId, useState } from "react";

import { errorMessage } from "@/api/errors";
import { useServerSettings } from "@/settings-sync/store";

import { ConnectorEntries } from "./connector-entries";
import { Field, Toggle } from "./fields";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

/** Words Settings search finds the group by. */
export const YOUR_BROWSER_KEYWORDS = [
  "browser",
  "chrome",
  "claude in chrome",
  "computer use",
  "cua",
  "extension",
  "web console",
  "click",
];

const PATCH: Record<AgentKind, (on: boolean) => SettingsPatch> = {
  claude: (claudeInChrome) => ({ agents: { claudeInChrome } }),
  codex: (codexComputerUse) => ({ agents: { codexComputerUse } }),
};

type Surface = keyof CodexSurfaces;

const SURFACE_PATCH: Record<Surface, (on: boolean) => SettingsPatch> = {
  chrome: (codexChrome) => ({ agents: { codexChrome } }),
  inApp: (codexInAppBrowser) => ({ agents: { codexInAppBrowser } }),
  apps: (codexMacApps) => ({ agents: { codexMacApps } }),
};

const SURFACES: ReadonlyArray<{
  surface: Surface;
  label: string;
  description: string;
  keywords: readonly string[];
}> = [
  {
    surface: "chrome",
    label: "Codex in your Chrome",
    description: "Through the ChatGPT extension, in your own Chrome with your sign-ins.",
    keywords: ["codex", "chrome", "chatgpt", "extension"],
  },
  {
    surface: "inApp",
    label: "Codex in ChatGPT's browser",
    description: "The browser inside the ChatGPT app, apart from your own.",
    keywords: ["codex", "chatgpt", "in-app browser"],
  },
  {
    surface: "apps",
    label: "Codex in Mac apps",
    description: "Other apps on this Mac, by looking at the screen and clicking.",
    keywords: ["codex", "mac", "apps", "desktop", "screen"],
  },
];

/**
 * Settings → Agents → Your browser: each agent's own consent to drive the user's real browser,
 * signed in as them. Off by default, one switch per agent. A thread still has to be given it, by
 * the user or, where Settings → Workspaces allows, by its orchestrator.
 */
export function YourBrowserSection() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [failed, setFailed] = useState<{ agent: AgentKind | Surface; message: string }>();
  const sitesId = useId();
  const appsId = useId();
  if (!settings) return null;

  const toggle = (agent: AgentKind) => {
    const checked = browserUseAllowed(settings, agent);
    const apply = (next: boolean) => {
      setFailed(undefined);
      save(PATCH[agent](next)).catch((e: unknown) =>
        setFailed({ agent, message: errorMessage(e) }),
      );
    };
    return {
      checked,
      onChange: apply,
      // Off is the default, so only an on switch has something to reset.
      onReset: checked ? () => apply(false) : undefined,
      error: failed?.agent === agent ? failed.message : undefined,
    };
  };

  const kept = codexSurfaces(settings);
  const codexOn = browserUseAllowed(settings, "codex");
  const surfaceToggle = (surface: Surface) => {
    const apply = (next: boolean) => {
      setFailed(undefined);
      save(SURFACE_PATCH[surface](next)).catch((e: unknown) =>
        setFailed({ agent: surface, message: errorMessage(e) }),
      );
    };
    return {
      checked: kept[surface],
      onChange: apply,
      // Kept is the default, so only one turned off has something to reset.
      onReset: kept[surface] ? undefined : () => apply(true),
      disabled: !codexOn,
      disabledReason: codexOn ? undefined : "Turn on Codex computer use first.",
      error: failed?.agent === surface ? failed.message : undefined,
    };
  };

  return (
    <SettingsGroup
      label="Your browser"
      anchor="your-browser"
      description="Threads you give it work in your own browser, signed in as you."
      learnMore={
        <p>
          Not the Preview pane: this is your real browser, with your sign-ins. A thread gets it only
          when you give it one (⌘K on the thread: Lend it your browser), or where Settings →
          Workspaces lets orchestrators use it or give it to their workers. Under a workspace that
          asks before anything leaves the machine, a Claude thread asks before each action in the
          browser; otherwise its permission mode and the extension&apos;s own site permissions
          decide. A change applies from a thread&apos;s next session.
        </p>
      }
      keywords={YOUR_BROWSER_KEYWORDS}
      testId="your-browser-settings"
    >
      <Toggle
        label="Claude in Chrome"
        description="Claude threads given the browser drive Chrome through the Claude extension."
        learnMore={
          <p>
            Needs the Claude extension installed and connected in Chrome, and a claude.ai sign-in:
            threads on a gateway or an API key don&apos;t get it. The extension asks before acting
            on a site you haven&apos;t allowed.
          </p>
        }
        keywords={["chrome", "extension", "--chrome"]}
        {...toggle("claude")}
      />
      <Toggle
        label="Codex computer use"
        description="Codex threads given the browser keep computer use: your browsers and Mac apps."
        learnMore={
          <p>
            Comes from the computer-use plugin the ChatGPT app installs in your own Codex setup, so
            it needs that app. Threads that run in Gram&apos;s own Codex setup, under a workspace
            that asks before anything leaves the machine, don&apos;t get it. Without this switch, a
            Codex thread runs with computer use off even where your setup has it. The three switches
            below choose what it reaches. One runtime serves all three, so with one browser kept,
            turning the other off takes away its skills, not the runtime.
          </p>
        }
        keywords={["codex", "cua", "computer use", "node_repl"]}
        {...toggle("codex")}
      />
      {SURFACES.map(({ surface, ...row }) => (
        <Toggle key={surface} {...row} {...surfaceToggle(surface)} />
      ))}
      <Field
        label="Allowed sites"
        description="Limit a lent browser to these sites. Empty means any."
        learnMore={
          <p>
            List a site by its host alone (github.com, localhost:3000). Each is matched exactly, so
            add a subdomain as its own entry. Codex is held to the list by its own site policy.
            Claude is refused when it opens an address on another site; a link it clicks on a listed
            site can still lead elsewhere, and the extension&apos;s own site permissions still
            apply. A change applies from a thread&apos;s next session.
          </p>
        }
        keywords={["sites", "domains", "allowlist", "origins", "browser"]}
        htmlFor={sitesId}
      >
        <ConnectorEntries
          id={sitesId}
          entries={settings.agents.browserSites ?? []}
          onChange={(browserSites) => save({ agents: { browserSites } })}
          problemOf={browserSiteProblem}
          placeholder="github.com"
          emptyReason="Type a site first."
          testId="browser-sites"
        />
      </Field>
      <Field
        label="Allowed Mac apps"
        description="Limit Codex to these Mac apps. Empty means any."
        learnMore={
          <p>
            List an app by its bundle id (com.apple.Safari). Only Codex computer use reaches Mac
            apps, and it is held to the list by its own app policy. A change applies from a
            thread&apos;s next session.
          </p>
        }
        keywords={["apps", "mac", "bundle id", "allowlist", "codex", "desktop"]}
        htmlFor={appsId}
      >
        <ConnectorEntries
          id={appsId}
          entries={settings.agents.browserApps ?? []}
          onChange={(browserApps) => save({ agents: { browserApps } })}
          problemOf={browserAppProblem}
          placeholder="com.apple.Safari"
          emptyReason="Type a bundle id first."
          testId="browser-apps"
        />
      </Field>
    </SettingsGroup>
  );
}
