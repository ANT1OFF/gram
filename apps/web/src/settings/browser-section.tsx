import { browserUseAllowed, type AgentKind, type SettingsPatch } from "@gram/contracts";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { useServerSettings } from "@/settings-sync/store";

import { Toggle } from "./fields";
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

/**
 * Settings → Agents → Your browser: each agent's own consent to drive the user's real browser,
 * signed in as them. Off by default, one switch per agent. A thread still has to be given it, by
 * the user or, where Settings → Workspaces allows, by its orchestrator.
 */
export function YourBrowserSection() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [failed, setFailed] = useState<{ agent: AgentKind; message: string }>();
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
            Codex thread runs with computer use off even where your setup has it.
          </p>
        }
        keywords={["codex", "cua", "computer use", "node_repl"]}
        {...toggle("codex")}
      />
    </SettingsGroup>
  );
}
