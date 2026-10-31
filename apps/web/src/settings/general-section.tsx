import {
  type LaunchAtLogin,
  DEFAULT_CLONE_FOLDER,
  notifyAboutOf,
  openAtLaunchOf,
  OVERVIEW_HIDDEN_BY_DEFAULT,
  OVERVIEW_OPTIONAL_SECTIONS,
  sendKeyOf,
  type OverviewOptionalSection,
  type SettingsPatch,
} from "@gram/contracts";
import { Settings2 } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { BRANCH_PREFIXES } from "@/composer/branch-name";
import { isMac } from "@/keyboard/registry";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { useServerSettings } from "@/settings-sync/store";
import { OVERVIEW_OPEN_FROM, useLayoutStore } from "@/stores/layout";

import { branchPrefixSetting } from "./branch-prefix";
import { GENERAL_DEFAULTS, resetFor } from "./defaults";
import { OptionGroup, rowInputCls, SettingRow, Toggle } from "./fields";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

const PREFIX_OPTIONS = BRANCH_PREFIXES.map((prefix) => ({ value: prefix, label: prefix }));

const SEND_KEYS = [
  { value: "enter", label: "Enter" },
  { value: "modEnter", label: "Shortcut only" },
] as const;

/**
 * What "Send with" says. The shortcut is named by its effective keys, not as ⌘Enter: Send and
 * Create thread are separate, rebindable entries in Settings → Keyboard, and promising a fixed
 * chord would be wrong for anyone who moved or turned off either.
 */
export const sendWithDescription = (send: string, create: string): string => {
  const keys =
    send === create
      ? send || "turned off"
      : `${send || "turned off"} in a thread and ${create || "turned off"} on New thread`;
  return `Enter sends and Shift+Enter adds a line, or only the shortcut sends (now ${keys}).`;
};

const OPEN_AT_LAUNCH = [
  { value: "orchestrator", label: "Last orchestrator" },
  { value: "thread", label: "Last thread" },
] as const;

/** The overview's optional sections, in the column's order, as Sidebar sections lists them. */
const OVERVIEW_SECTION_LABELS: Readonly<Record<OverviewOptionalSection, string>> = {
  solo: "Solo threads",
  pullRequests: "Pull requests",
  doneToday: "Done today",
  usage: "Usage and slots",
};

const OVERVIEW_SIDEBAR = [
  { value: "automatic", label: "Automatic" },
  { value: "open", label: "Open" },
  { value: "compact", label: "Compact" },
  { value: "hidden", label: "Hidden" },
] as const;

const NOTIFY_ABOUT = [
  { value: "asksAndFailures", label: "Asks and failures" },
  { value: "asks", label: "Asks only" },
] as const;

const PANEL_SIDES = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
] as const;

/** Settings → General: new-thread defaults and layout. */
export function GeneralSection() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [failed, setFailed] = useState<{ key: string; message: string }>();
  const sendHint = useShortcutHint("composer.send");
  const createHint = useShortcutHint("draft.create");
  // Synced through the layout store, so ⌘B and this row are one setting.
  const overview = useLayoutStore((s) => s.overviewSidebar);
  const setOverview = useLayoutStore((s) => s.setOverviewSidebar);
  const overviewHint = useShortcutHint("sidebar.toggle");
  const overviewHidden = useLayoutStore((s) => s.overviewHidden);
  const setOverviewHidden = useLayoutStore((s) => s.setOverviewHidden);

  if (!settings) return <p className="text-sm text-muted-foreground">Loading settings…</p>;

  /** Saves `patch`, and puts a failure under the row `key` names. */
  const applyTo = (key: keyof typeof GENERAL_DEFAULTS) => (patch: SettingsPatch) => {
    setFailed(undefined);
    save(patch).catch((e: unknown) => setFailed({ key, message: errorMessage(e) }));
  };
  const errorOf = (key: keyof typeof GENERAL_DEFAULTS) =>
    failed?.key === key ? failed.message : undefined;
  const resetOf = (key: keyof typeof GENERAL_DEFAULTS) =>
    resetFor(settings, applyTo(key))(GENERAL_DEFAULTS[key]);

  return (
    <div className="flex flex-col gap-6" data-testid="general-settings">
      <SettingsGroup label="Launch and layout">
        <SettingRow
          label="Open at launch"
          description="What a new launch opens: the orchestrator you used last, or the thread you had open last."
          keywords={["launch", "start", "startup", "home", "reopen"]}
          onReset={resetOf("openAtLaunch")}
          error={errorOf("openAtLaunch")}
        >
          <OptionGroup
            label="Open at launch"
            options={OPEN_AT_LAUNCH}
            value={openAtLaunchOf(settings)}
            onChange={(openAtLaunch) =>
              applyTo("openAtLaunch")({
                layout: { openAtLaunch: openAtLaunch === "orchestrator" ? null : openAtLaunch },
              })
            }
          />
        </SettingRow>
        <SettingRow
          label="Overview sidebar"
          description={`The window's left column: what needs you, every workspace's orchestrator with the current one's workers, and solo threads. Compact is a narrow rail of tiles; Automatic is open from ${OVERVIEW_OPEN_FROM} px, compact below.${overviewHint ? ` ${overviewHint} hides or shows it.` : ""}`}
          keywords={[
            "overview",
            "sidebar",
            "workers",
            "orchestrators",
            "solo",
            "left",
            "rail",
            "compact",
          ]}
          onReset={overview === undefined ? undefined : () => setOverview(undefined)}
        >
          <OptionGroup
            label="Overview sidebar"
            options={OVERVIEW_SIDEBAR}
            value={overview ?? "automatic"}
            onChange={(mode) => setOverview(mode === "automatic" ? undefined : mode)}
          />
        </SettingRow>
        <SettingRow
          label="Sidebar sections"
          description="Which of the overview sidebar's optional sections show: solo threads, pull requests, Done today, and usage with worker slots at its foot, off by default as the title bar's meter has them."
          keywords={[
            "overview",
            "sections",
            "solo",
            "pull requests",
            "done today",
            "usage",
            "slots",
          ]}
          onReset={
            overviewHidden.join() === OVERVIEW_HIDDEN_BY_DEFAULT.join()
              ? undefined
              : () => setOverviewHidden(OVERVIEW_HIDDEN_BY_DEFAULT)
          }
        >
          <SectionChecks hidden={overviewHidden} onChange={setOverviewHidden} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup label="Threads">
        <FolderField
          // A saved value from elsewhere resets the draft.
          key={`default:${settings.agents.defaultFolder ?? ""}`}
          id="settings-default-folder"
          label="Default folder"
          description="Where the project picker starts for a new thread. ~ is your home folder."
          placeholder="~/code"
          value={settings.agents.defaultFolder}
          onReset={resetOf("defaultFolder")}
          error={errorOf("defaultFolder")}
          onSave={(folder) =>
            applyTo("defaultFolder")({ agents: { defaultFolder: folder === "" ? null : folder } })
          }
        />
        <FolderField
          key={`clone:${settings.agents.cloneFolder ?? ""}`}
          id="settings-clone-folder"
          label="Where new clones go"
          description="Where repositories added by GitHub name or URL are cloned. Empty means ~/Documents/code."
          placeholder={DEFAULT_CLONE_FOLDER}
          value={settings.agents.cloneFolder}
          onReset={resetOf("cloneFolder")}
          error={errorOf("cloneFolder")}
          onSave={(folder) =>
            applyTo("cloneFolder")({ agents: { cloneFolder: folder === "" ? null : folder } })
          }
        />
        <SettingRow
          label="Branch prefix"
          description="New worktree branches start with this prefix, such as feat/brave-otter."
          onReset={resetOf("branchPrefix")}
          error={errorOf("branchPrefix")}
        >
          <OptionGroup
            label="Branch prefix"
            options={PREFIX_OPTIONS}
            value={branchPrefixSetting(settings.agents.branchPrefix)}
            onChange={(branchPrefix) => applyTo("branchPrefix")({ agents: { branchPrefix } })}
          />
        </SettingRow>
        <Toggle
          label="Follow worktree moves"
          description="When an agent moves into another worktree, the panels and git state follow it."
          checked={settings.agents.followWorktreeMoves}
          onReset={resetOf("followWorktreeMoves")}
          error={errorOf("followWorktreeMoves")}
          onChange={(followWorktreeMoves) =>
            applyTo("followWorktreeMoves")({ agents: { followWorktreeMoves } })
          }
        />
      </SettingsGroup>
      <SettingsGroup label="Composer and panels">
        <SettingRow
          label="Send with"
          description={sendWithDescription(sendHint, createHint)}
          onReset={resetOf("sendKey")}
          error={errorOf("sendKey")}
        >
          <OptionGroup
            label="Send with"
            options={SEND_KEYS}
            value={sendKeyOf(settings)}
            onChange={(sendKey) => applyTo("sendKey")({ composer: { sendKey } })}
          />
        </SettingRow>
        <SettingRow
          label="Side panel"
          description="Which side of the chat the Diff, PR, Files and Terminal panel sits on."
          onReset={resetOf("panelSide")}
          error={errorOf("panelSide")}
        >
          <OptionGroup
            label="Side panel"
            options={PANEL_SIDES}
            value={settings.panel.side}
            onChange={(side) => applyTo("panelSide")({ panel: { side } })}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup label="Interruptions">
        <Toggle
          label="Quiet when idle"
          description="After five idle minutes with nothing asked, the window goes quiet."
          keywords={["quiet", "idle", "away", "calm"]}
          checked={settings.layout?.quietWhenIdle === true}
          onReset={resetOf("quietWhenIdle")}
          error={errorOf("quietWhenIdle")}
          onChange={(quietWhenIdle) =>
            applyTo("quietWhenIdle")({ layout: { quietWhenIdle: quietWhenIdle ? true : null } })
          }
        />
        <SettingRow
          label="Notify me about"
          description="What raises a desktop notification while Gram isn't in front. Asks always do; the rest waits for Since you left."
          keywords={["notifications", "interrupt", "failures", "errors", "asks"]}
          onReset={resetOf("notifyAbout")}
          error={errorOf("notifyAbout")}
        >
          <OptionGroup
            label="Notify me about"
            options={NOTIFY_ABOUT}
            value={notifyAboutOf(settings)}
            onChange={(notifyAbout) =>
              applyTo("notifyAbout")({
                notifications: {
                  notifyAbout: notifyAbout === "asksAndFailures" ? null : notifyAbout,
                },
              })
            }
          />
        </SettingRow>
      </SettingsGroup>
      <WindowSettings />
    </div>
  );
}

/** The desktop shell's own settings; nothing in a browser or a shell that keeps neither. */
function WindowSettings() {
  const bridge = window.gram;
  if (bridge?.keepInTray === undefined && bridge?.launchAtLogin === undefined) return null;
  return (
    <SettingsGroup label="Window">
      <LaunchAtLoginSetting />
      <KeepInTraySetting />
    </SettingsGroup>
  );
}

/**
 * "Open at login", which the OS keeps (macOS Login Items). A login launch starts with no window,
 * so asks reach the menu bar and notifications after a restart. Nothing where the shell can't
 * offer it: a browser, Linux, or a development run.
 */
export function LaunchAtLoginSetting() {
  const login = window.gram?.launchAtLogin;
  const [state, setState] = useState<LaunchAtLogin | null>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void login
      ?.get()
      .then((value) => {
        if (live) setState(value);
      })
      .catch(() => {
        if (live) setState(null);
      });
    return () => {
      live = false;
    };
  }, [login]);
  if (login === undefined || state === undefined || state === null) return null;
  const mac = isMac();
  return (
    <Toggle
      label="Open at login"
      description={
        mac
          ? "Starts Gram when you log in, with no window open: the Dock icon or menu bar item brings it back."
          : "Starts Gram when you sign in, with no window open while it keeps running in the tray."
      }
      keywords={["login", "startup", "start", "boot", "background", "login items"]}
      checked={state.enabled}
      error={error}
      detail={
        state.needsApproval ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Waiting for your approval in System Settings → General → Login Items.</span>
            <Hint
              label="Open Login Items"
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Open Login Items"
                  onClick={() => void login.openSettings()}
                />
              }
            >
              <Settings2 aria-hidden />
            </Hint>
          </div>
        ) : undefined
      }
      onChange={(enabled) => {
        setError(undefined);
        const before = state;
        setState({ enabled, needsApproval: false });
        login
          .set(enabled)
          .then((next) => setState(next ?? before))
          .catch((e: unknown) => {
            setState(before);
            setError(errorMessage(e));
          });
      }}
    />
  );
}

/**
 * "Keep running in tray", which the desktop shell keeps. On macOS, where the Dock keeps a
 * windowless app anyway, it is the menu bar item with the asks and workspaces. Nothing in a browser.
 */
export function KeepInTraySetting() {
  const tray = window.gram?.keepInTray;
  const [checked, setChecked] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    // Another window can change it too; a change seen first wins over a read still in flight.
    let changed = false;
    const unsubscribe = tray?.onChange((value) => {
      changed = true;
      setChecked(value);
    });
    void tray?.get().then((value) => {
      if (live && !changed) setChecked(value);
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [tray]);
  if (tray === undefined || checked === undefined) return null;
  return (
    <Toggle
      {...(isMac()
        ? {
            label: "Show in menu bar",
            description: "Asks and workspaces in the menu bar.",
          }
        : {
            label: "Keep running in tray",
            description: "Closing the last window leaves Gram running in the system tray.",
          })}
      keywords={["close", "quit", "background", "system tray", "notification area", "menu bar"]}
      checked={checked}
      error={error}
      onChange={(enabled) => {
        setError(undefined);
        setChecked(enabled);
        tray.set(enabled).catch((e: unknown) => {
          setChecked(!enabled);
          setError(errorMessage(e));
        });
      }}
    />
  );
}

/** A folder setting, saved on blur or Enter; an empty field clears it. */
function FolderField({
  id,
  label,
  description,
  placeholder,
  value,
  onSave,
  onReset,
  error,
}: {
  id: string;
  label: string;
  description: string;
  placeholder: string;
  value: string | undefined;
  onSave: (folder: string) => void;
  onReset: (() => void) | undefined;
  error: string | undefined;
}) {
  const [draft, setDraft] = useState(value ?? "");

  const commit = () => {
    const next = draft.trim();
    if (next !== (value ?? "")) onSave(next);
  };

  return (
    <SettingRow
      label={label}
      description={description}
      htmlFor={id}
      onReset={onReset}
      error={error}
    >
      <input
        id={id}
        className={rowInputCls}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </SettingRow>
  );
}

/** The overview's optional sections as checkboxes, each on unless unchecked. */
function SectionChecks({
  hidden,
  onChange,
}: {
  hidden: readonly OverviewOptionalSection[];
  onChange: (hidden: readonly OverviewOptionalSection[]) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Sidebar sections"
      data-testid="overview-sections-setting"
      className="flex flex-wrap justify-end gap-x-4 gap-y-1.5"
    >
      {OVERVIEW_OPTIONAL_SECTIONS.map((section) => (
        <label key={section} className="flex cursor-pointer items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            data-section={section}
            checked={!hidden.includes(section)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? hidden.filter((each) => each !== section)
                  : [...hidden, section],
              )
            }
            className="size-3.5 accent-primary"
          />
          {OVERVIEW_SECTION_LABELS[section]}
        </label>
      ))}
    </div>
  );
}
