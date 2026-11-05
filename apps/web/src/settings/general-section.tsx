import {
  type LaunchAtLogin,
  DEFAULT_CLONE_FOLDER,
  keepAwakeOn,
  openAtLaunchOf,
  OVERVIEW_HIDDEN_BY_DEFAULT,
  OVERVIEW_OPTIONAL_SECTIONS,
  sendKeyOf,
  type OverviewOptionalSection,
  type SettingsPatch,
} from "@gram/contracts";
import { Settings2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

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
import { DraftActions, dropUndo, offerUndo, SaveHint } from "./save-hint";
import { claimTouchedRow, markSaved, markTouchedSaved } from "./saved-mark";
import { GENERAL_ANCHORS } from "./general-anchors";
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
  doneToday: "History",
  usage: "Usage and slots",
};

const OVERVIEW_SIDEBAR = [
  { value: "automatic", label: "Automatic" },
  { value: "open", label: "Open" },
  { value: "compact", label: "Compact" },
  { value: "hidden", label: "Hidden" },
] as const;

const PANEL_SIDES = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
] as const;

/**
 * Settings → General: Launch, Navigation, Folders & branches, Sending and Running work, each a group
 * the nav links to (`GENERAL_ANCHORS`).
 */
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

  if (!settings) return <p className="text-reading text-muted-foreground">Loading settings…</p>;

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
      <SettingsGroup
        label="Launch"
        anchor={GENERAL_ANCHORS.launch}
        description="What Gram opens when it starts, and how it keeps running."
      >
        <SettingRow
          label="Open at launch"
          description="Reopen the orchestrator you used last, or your last thread."
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
        <LaunchAtLoginSetting />
        <KeepInTraySetting />
      </SettingsGroup>
      <SettingsGroup
        label="Navigation"
        anchor={GENERAL_ANCHORS.navigation}
        description="How the left sidebar looks, and where the side panel sits."
      >
        <SettingRow
          label="Overview sidebar"
          description={`The left column of threads.${overviewHint ? ` ${overviewHint} hides or shows it.` : ""}`}
          learnMore={
            <p>
              It lists what needs you, every workspace&rsquo;s orchestrator with the current
              one&rsquo;s workers, and solo threads. Compact is a narrow rail of tiles; Automatic is
              open from {OVERVIEW_OPEN_FROM} px wide and compact below.
            </p>
          }
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
            onChange={(mode) => {
              setOverview(mode === "automatic" ? undefined : mode);
              markTouchedSaved();
            }}
          />
        </SettingRow>
        <SettingRow
          label="Sidebar sections"
          description="Which optional sections the left sidebar shows."
          learnMore={
            <p>
              Usage and slots sits at the sidebar&rsquo;s foot. It is off by default, since the
              title bar&rsquo;s meter shows the same.
            </p>
          }
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
          <SectionChecks
            hidden={overviewHidden}
            onChange={(hidden) => {
              setOverviewHidden(hidden);
              markTouchedSaved();
            }}
          />
        </SettingRow>
        <SettingRow
          label="Side panel"
          description="Where the Diff, PR, Files and Terminal panel sits."
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
      <SettingsGroup
        label="Folders & branches"
        anchor={GENERAL_ANCHORS.folders}
        description="Where new threads and clones start, and how their branches are named."
      >
        <FolderField
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
          id="settings-clone-folder"
          label="Where new clones go"
          description="Where repositories added by GitHub name or URL are cloned."
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
          description="New worktree branches start with it, such as feat/brave-otter."
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
      </SettingsGroup>
      <SettingsGroup
        label="Sending"
        anchor={GENERAL_ANCHORS.sending}
        description="Which keys send a message."
      >
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
      </SettingsGroup>
      <SettingsGroup
        label="Running work"
        anchor={GENERAL_ANCHORS.running}
        description="What happens while agents run: staying awake, and following their worktree."
      >
        <Toggle
          label="Keep computer awake while agents run"
          description="Stops the system from sleeping while a turn is running; the display can still sleep."
          keywords={["sleep", "power", "awake", "agents"]}
          checked={keepAwakeOn(settings)}
          onReset={resetOf("keepAwake")}
          error={errorOf("keepAwake")}
          onChange={(keepAwake) =>
            applyTo("keepAwake")({ agents: { keepAwake: keepAwake ? null : false } })
          }
        />
        <Toggle
          label="Follow worktree moves"
          description="When an agent switches worktree, the panels follow it."
          checked={settings.agents.followWorktreeMoves}
          onReset={resetOf("followWorktreeMoves")}
          error={errorOf("followWorktreeMoves")}
          onChange={(followWorktreeMoves) =>
            applyTo("followWorktreeMoves")({ agents: { followWorktreeMoves } })
          }
        />
      </SettingsGroup>
    </div>
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
          ? "Start Gram in the background when you log in."
          : "Start Gram in the tray when you sign in."
      }
      learnMore={
        mac ? (
          <p>It starts with no window; the Dock icon or menu bar item brings it back.</p>
        ) : undefined
      }
      keywords={["login", "startup", "start", "boot", "background", "login items"]}
      checked={state.enabled}
      error={error}
      detail={
        state.needsApproval ? (
          <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
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
        const row = claimTouchedRow();
        login
          .set(enabled)
          .then((next) => {
            setState(next ?? before);
            markSaved(row);
          })
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
        const row = claimTouchedRow();
        tray.set(enabled).then(
          () => markSaved(row),
          (e: unknown) => {
            setChecked(!enabled);
            setError(errorMessage(e));
          },
        );
      }}
    />
  );
}

/**
 * Why `folder` can't be saved as a folder setting, if it can't: the server resolves it on its own,
 * so a relative path would mean nothing it could show here. Empty clears the setting.
 */
function folderProblem(folder: string): string | undefined {
  if (folder === "" || folder === "~" || /^(~[/\\]|\/|[A-Za-z]:[/\\]|\\\\)/.test(folder)) return;
  return "Use a full path, starting with ~/ or /.";
}

/**
 * A folder setting, saved on Enter or when the field loses focus; an empty field clears it, and
 * Escape puts the saved value back. While the draft differs from what is saved, the row says how to
 * save it; once saved it says "Saved", and a path it can't save says why under the row.
 */
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
  const [invalid, setInvalid] = useState<string>();
  const [saved, setSaved] = useState(value);
  // A saved value, from here or elsewhere, resets the draft. The row stays mounted, so the "Saved"
  // its own save shows stays with it.
  if (value !== saved) {
    setSaved(value);
    setDraft(value ?? "");
    setInvalid(undefined);
  }
  const hintId = useId();
  const unsaved = draft.trim() !== (value ?? "") && invalid === undefined;

  const commit = () => {
    const next = draft.trim();
    if (next === (value ?? "")) return setInvalid(undefined);
    const problem = folderProblem(next);
    setInvalid(problem);
    if (problem === undefined) {
      const before = value ?? "";
      offerUndo(id, () => onSave(before));
      onSave(next);
    }
  };
  const cancel = () => {
    setDraft(value ?? "");
    setInvalid(undefined);
  };

  return (
    <SettingRow
      label={label}
      description={description}
      htmlFor={id}
      onReset={onReset}
      error={invalid ?? error}
      hint={unsaved ? <SaveHint id={hintId} /> : undefined}
      undoKey={id}
    >
      <input
        id={id}
        className={rowInputCls}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={invalid !== undefined || undefined}
        aria-describedby={unsaved ? hintId : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(undefined);
          dropUndo(id);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") cancel();
        }}
      />
      {unsaved && <DraftActions label={label} onSave={commit} onCancel={cancel} />}
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
        <label key={section} className="flex cursor-pointer items-center gap-1.5 text-reading">
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
