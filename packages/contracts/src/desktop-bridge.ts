import type { DesktopWindows } from "./app-windows.ts";
import type { DesktopPreview } from "./preview.ts";
import type { UpdateChannel } from "./settings.ts";
import type { DesktopSpeech } from "./speech-bridge.ts";
import type { TrayAction, TrayMenu } from "./tray-menu.ts";

export * from "./tray-menu.ts";

/**
 * The app icons Settings offers, in its order. The first is the one the app ships with; the others
 * replace it in the Dock or taskbar while Gram runs.
 */
export const APP_ICONS = ["gift", "fanout", "blade", "glass"] as const;

export type AppIconId = (typeof APP_ICONS)[number];

export const isAppIconId = (value: unknown): value is AppIconId =>
  typeof value === "string" && (APP_ICONS as readonly string[]).includes(value);

/** One step of window zoom. */
export type WindowZoomStep = "in" | "out" | "reset";

/** A menu command the desktop shell forwards to the focused window. */
/** `closePane` empties the focused pane; `closeThread` asks to close its thread. */
export type DesktopMenuAction =
  | "closePane"
  | "closeThread"
  | "closeAllThreads"
  | "newWindow"
  | "newThread"
  | "palette"
  | "settings"
  | "whatsNew"
  | "shortcuts"
  | "openLogsFolder"
  | "copyDiagnostics"
  | "reportIssue";

/** The shortcuts the desktop menu shows and answers to, by keyboard catalog id. */
export const MENU_SHORTCUT_IDS = [
  "settings.open",
  "thread.new",
  "window.new",
  "pane.close",
  "thread.close",
  "palette.open",
  "overlay.shortcutsAnywhere",
] as const;

export type MenuShortcutId = (typeof MENU_SHORTCUT_IDS)[number];

/** Each menu shortcut's effective keys (`mod+shift+n`), or `null` when the user turned it off. */
export type MenuShortcuts = Readonly<Partial<Record<MenuShortcutId, string | null>>>;

export interface DesktopNotification {
  readonly title: string;
  readonly body: string;
  /** Echoed back through `onNotificationClick` when the user clicks the notification. */
  readonly threadId?: string;
  /**
   * An ask's notification: echoed back through `onNotificationAction`, never through
   * `onNotificationClick`. One live notification per id; showing an id again replaces it.
   */
  readonly id?: string;
  /** A line under the title, on macOS. */
  readonly subtitle?: string;
  /**
   * Buttons that answer (`NOTICE_ACTIONS`), before an Open the shell adds. The shell drops them
   * unless the body is shown whole (`noticeBodyFits`), and on platforms without buttons.
   */
  readonly actions?: readonly string[];
}

/** What the user did with an ask's notification: one of its `actions` by index, or opened it. */
export interface DesktopNotificationAction {
  readonly id: string;
  readonly action: number | "open";
}

export interface TitleBarTheme {
  /** `#rrggbb` (or `#rgb` / `#rrggbbaa`) window and title-bar background. */
  readonly background: string;
  /** Colour of the Windows caption buttons. */
  readonly foreground: string;
  /** Drives native controls and `prefers-color-scheme`. */
  readonly mode: "light" | "dark" | "system";
}

/** How a release relates to the running version; an older pick is an explicit downgrade. */
export type ReleaseRelation = "newer" | "older" | "current";

/** One installable release of the channel: a version-picker row. */
export interface ReleaseInfo {
  /** Main-issued short-lived install capability, where the updater issues one. */
  readonly installId?: string;
  readonly tag: string;
  readonly version: string;
  readonly prerelease: boolean;
  readonly relation: ReleaseRelation;
  /** Display-only metadata from the authenticated release, never installation authority. */
  readonly notes?: string;
  readonly htmlUrl?: string;
  readonly sourceCommit?: string;
  /** A Developer ID signed, notarized macOS build this app verifies against its publisher's team. */
  readonly signed?: true;
}

export interface UpdateCheck {
  readonly installId?: string;
  /** Epoch ms when the release check finished (including failure); cached answers retain it. */
  readonly checkedAt?: number;
  readonly available: boolean;
  /** `gh` is missing, logged out or failed: the feature is silently off. */
  readonly unavailable?: true;
  /** With `unavailable`: Gram has no releases repo yet, so nothing was checked. */
  readonly noReleaseChannel?: true;
  /**
   * With `unavailable`: what to do about it, in the release source's words. Absent, the source is
   * the desktop's `gh`, and the page says what that needs.
   */
  readonly unavailableMessage?: string;
  readonly currentVersion: string;
  /** True only where the current build can safely self-install. */
  readonly canSelfInstall: boolean;
  /** The requested channel when reported; older/unavailable checks may omit it. */
  readonly channel?: UpdateChannel;
  readonly latestVersion?: string;
  readonly tag?: string;
  /** The latest release is Developer ID signed; see `ReleaseInfo.signed`. */
  readonly signed?: true;
  /** The release page; empty on self-install builds, which never open it. */
  readonly htmlUrl?: string;
  /** The channel's installable releases, newest first, present even when nothing is newer. */
  readonly releases?: readonly ReleaseInfo[];
}

/** What an update needs from the old server's stop before main may kill the rest of it. */
export type UpdateEssential = "sessions" | "agents" | "database";

/**
 * How the old server stopped for an update: its whole teardown finished (`clean`); its essentials
 * were attested and the rest of its process tree was killed, none of it surviving (`forced`, with
 * the executable names killed and the handle kinds its teardown still waited on); or the update was
 * refused before the bundle was touched (`refused`, with the essential that failed, `survivor`
 * for a process the kill left, `unverified` when the tree couldn't be read, `teardown` for any
 * other incomplete stop).
 */
export type UpdateTeardown =
  | { readonly path: "clean" }
  | {
      readonly path: "forced";
      readonly killed: number;
      readonly names: ReadonlyArray<string>;
      readonly waitingOn: Readonly<Record<string, number>>;
    }
  | {
      readonly path: "refused";
      readonly reason: UpdateEssential | "survivor" | "unverified" | "teardown";
    };

/**
 * What the user asked to install: a `ReleaseInfo.tag` from a check of `channel`, and whether they
 * chose it as a downgrade. The desktop shell re-checks all three before downloading anything.
 */
export interface UpdateInstallIntent {
  readonly installId?: string;
  readonly channel: UpdateChannel;
  readonly tag: string;
  /** The user picked an older release than the running one, as a downgrade. */
  readonly downgrade: boolean;
}

/** `updating: true` means the installer is verified and launched; the app is about to exit. */
export type UpdateInstallResult =
  | { readonly updating: true }
  | { readonly updating: false; readonly error: string };

export interface UpdateProgress {
  readonly stage: "downloading" | "verifying" | "installing" | "failed";
  readonly tag: string;
  readonly error?: string;
}

/**
 * Where a signed install's update stands, from Electron's updater (Squirrel.Mac): `idle` before
 * the first check, `ready` once the download is verified and a restart installs it, `installing`
 * while Gram stops for it.
 */
export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

/** Which step an `error` came from, so a retry knows what to do again. */
export type AppUpdateErrorStep = "check" | "download" | "install";

/** An update the last restart was for that didn't land: the app came back on the old version. */
export interface AppUpdateNotApplied {
  readonly version: string;
  /** What went wrong, or where its log is, in words. */
  readonly reason: string;
}

/**
 * Where this install's updater reads releases. `public` reads `repo` anonymously (a signed Mac's
 * Electron updater), `private` with the user's own `gh` login (the `gh` updater). `repo` is null
 * when the build has no release channel.
 */
export interface UpdateSource {
  readonly repo: string | null;
  readonly visibility: "private" | "public";
}

export interface AppUpdateState {
  readonly status: AppUpdateStatus;
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  /** The newer release found, from `available` on. */
  readonly availableVersion: string | null;
  /** The verified download a restart would install. */
  readonly downloadedVersion: string | null;
  /** The release's plain-text notes, bounded; null when it has none. */
  readonly releaseNotes: string | null;
  /** ISO time the release was published. */
  readonly releaseDate: string | null;
  /** 0 to 100 while downloading. */
  readonly percent: number | null;
  /** Epoch ms the last check finished. */
  readonly checkedAt: number | null;
  /** The running check, or the last one, was asked for by the user rather than the timer. */
  readonly manual: boolean;
  /** Why the last step failed or was refused, in one line. */
  readonly message: string | null;
  readonly errorStep: AppUpdateErrorStep | null;
  readonly notApplied: AppUpdateNotApplied | null;
  /** This installation can replace itself (packaged, in Applications, writable). */
  readonly canInstall: boolean;
}

/**
 * Electron's updater on Developer ID signed macOS installs. Absent in older shells; `state`
 * resolves null everywhere else: Windows' `gh` updater, and unsigned macOS builds, which have no
 * in-app updater.
 */
export interface DesktopNativeUpdates {
  state(): Promise<AppUpdateState | null>;
  onState(callback: (state: AppUpdateState) => void): () => void;
  /** Checks `channel` now, as the user asked; resolves once the check settled. */
  check(channel: UpdateChannel): Promise<AppUpdateState>;
  /** Downloads and verifies the available update; progress arrives through `onState`. */
  download(): Promise<AppUpdateState>;
  /**
   * Stops Gram for the update `version` (the stop fence) and restarts into it. Resolves with the
   * state: `installing` on the way out, or the refusal's reason with nothing quit.
   */
  install(version: string): Promise<AppUpdateState>;
  /** Clears a shown error or "not applied" notice. */
  dismiss(): Promise<AppUpdateState>;
}

/** A window's socket to the server, as `DesktopBridge.reportConnection` sends it. */
export interface DesktopConnectionReport {
  readonly status: "connecting" | "open" | "reconnecting" | "expired";
  /** Failed attempts since it was last open. */
  readonly attempt?: number | undefined;
}

/** Identity of this running desktop process, independent of release checks. */
export interface AppBuildInfo {
  readonly version: string;
  readonly packaged: boolean;
  /** Captured from a clean checkout at build time. Absent for dirty/unknown source. */
  readonly sourceCommit?: string;
}

/** Native affordances the desktop preload exposes on `window.gram`. Absent in a browser. */
/**
 * "Open at login", as the OS keeps it: macOS's Login Items (`SMAppService`) or the Windows run key.
 * `needsApproval` means macOS registered the app but waits for the user to allow it in System
 * Settings → General → Login Items.
 */
export interface LaunchAtLogin {
  readonly enabled: boolean;
  readonly needsApproval: boolean;
}

/**
 * What the shell saw happen to the newest of Gram's notifications since it started. Electron can't
 * read whether the OS allows them, so this is the only honest status: `sent` (no answer from the OS
 * yet), `shown` (the OS accepted it, though Focus or the alert style can still keep it off screen),
 * `clicked`, or `failed` with the OS's error, which on macOS is what not being allowed looks like.
 */
export interface NotificationStatus {
  readonly supported: boolean;
  readonly last: {
    readonly outcome: "sent" | "shown" | "clicked" | "failed";
    readonly at: number;
    /** Whether it was Settings' test notification. */
    readonly test: boolean;
    readonly error?: string;
  } | null;
}

export interface DesktopBridge extends DesktopWindows {
  readonly platform: "darwin" | "win32" | "linux" | (string & {});
  /** Absolute filesystem path of a dropped/selected `File`. */
  getPathForFile(file: File): string;
  /**
   * Subscribes to menu commands; returns the unsubscribe function. `newWindow` is handled by the
   * shell and not delivered.
   */
  onMenu(callback: (action: DesktopMenuAction) => void): () => void;
  /** The "needs you" count: the dock badge on macOS, a taskbar overlay + flash on Windows. 0 clears. */
  setBadge(count: number): void;
  /** Shows a native notification. The renderer decides when (e.g. only while unfocused). */
  notify(notification: DesktopNotification): void;
  /**
   * Tells the shell how this window's socket to the server stands, as the reconnect banner shows
   * it, so its log can tell a hung window from a lost server. Absent in shells older than it.
   */
  reportConnection?(connection: DesktopConnectionReport): void;
  /** Subscribes to notification clicks; the shell focuses the window first. */
  onNotificationClick(callback: (threadId: string | null) => void): () => void;
  /**
   * Subscribes to what the user does with a notification that has an `id`: an action button, or a
   * click (`"open"`, after the shell focuses the window). Absent in shells older than it.
   */
  onNotificationAction?(callback: (action: DesktopNotificationAction) => void): () => void;
  /** Takes back the notification with `id`, from the screen and Notification Center. */
  withdrawNotification?(id: string): void;
  /** Syncs the native window background, title-bar overlay and appearance with the active palette. */
  setTitleBarTheme(theme: TitleBarTheme): void;
  /** Glass look: macOS vibrancy / Windows Mica, skipped while the OS asks for reduced transparency. */
  setVibrancy(enabled: boolean): void;
  /**
   * The Dock or taskbar icon (`APP_ICONS`), which the shell remembers and applies at launch. Absent
   * in shells older than it.
   */
  appIcon?: {
    get(): Promise<AppIconId>;
    set(icon: AppIconId): Promise<void>;
  };
  /** Gives the menu the user's keybindings, so its accelerators match the renderer's shortcuts. */
  setMenuShortcuts?(shortcuts: MenuShortcuts): void;
  /**
   * Zooms this window one step, or back to actual size: the same zoom as View → Zoom In / Out, for
   * a key press the menu's accelerator didn't catch (see `window-zoom-keys.ts`).
   */
  zoom?(step: WindowZoomStep): void;
  /**
   * Opens an http(s) URL in the default browser. The shell asks first, in a native dialog, unless
   * the link is https to a host in `trustedLinks`; resolves false when nothing opened.
   */
  openExternal(url: string): Promise<boolean>;
  /**
   * Opens `http://localhost:<port>` without asking. The page picks only the port, never a host,
   * path or query, so there is nothing in it for an injected link to carry.
   */
  openLocalPort?(port: number): Promise<boolean>;
  /**
   * The hosts whose links open without asking. Only the shell's own link dialog adds one, so the
   * renderer can read and shrink the list but never grow it. Present when the shell asks about
   * links itself, so the page shouldn't ask as well.
   */
  readonly trustedLinks?: {
    list(): Promise<readonly string[]>;
    remove(host: string): Promise<void>;
    onChange(callback: (hosts: readonly string[]) => void): () => void;
  };
  /**
   * "Agent may browse": the public hosts agents may open and read in the Preview pane without a
   * card, apart from `trustedLinks`, since trusting a link to open isn't trusting an agent on the
   * site. Only an approval card's "Always for this host" adds one, so the renderer can read and
   * shrink the list but never grow it. Absent from shells that predate it.
   */
  readonly agentBrowse?: {
    list(): Promise<readonly string[]>;
    remove(host: string): Promise<void>;
    onChange(callback: (hosts: readonly string[]) => void): () => void;
  };
  /** Writes plain text to the system clipboard. */
  copyText(text: string): Promise<void>;
  /** Shows an absolute path selected in Finder / Explorer; resolves false when it doesn't exist. */
  showItemInFolder?(path: string): Promise<boolean>;
  /** The font families installed on this computer, sorted; empty when they can't be listed. */
  listFonts?(): Promise<readonly string[]>;
  /** Opens macOS Privacy & Security → Files & Folders; resolves false elsewhere or on failure. */
  openPrivacySettings?(): Promise<boolean>;
  /**
   * Opens the third-party notices that ship with the app in the system's text viewer; resolves
   * false when the file is missing or won't open. Absent in shells older than it.
   */
  openAcknowledgements?(): Promise<boolean>;
  /** The system folder dialog; the chosen folder, or `undefined` when cancelled. */
  chooseFolder?(options?: { readonly defaultPath?: string }): Promise<string | undefined>;
  /** The app bundle (the `.app` on macOS, else the executable), for diagnostic details. */
  appBundlePath?(): Promise<string>;
  /** Older shells do not supply build provenance. This never reads runtime Git state. */
  appBuildInfo?(): Promise<AppBuildInfo>;
  /**
   * "Keep running in the tray": whether closing the last window leaves the app running in the
   * system tray rather than quitting. Kept by the shell, off unless turned on. On macOS, whose Dock
   * keeps a windowless app anyway, it only shows the menu bar item. Absent in shells older than it.
   */
  readonly keepInTray?: {
    get(): Promise<boolean>;
    set(enabled: boolean): Promise<void>;
    /** Subscribes to changes from any window; returns the unsubscribe function. */
    onChange(callback: (enabled: boolean) => void): () => void;
  };
  /**
   * "Open at login". `get` resolves null where the shell can't offer it (Linux, a development or
   * smoke run). A login launch starts with its windows hidden. Absent in shells older than it.
   */
  readonly launchAtLogin?: {
    get(): Promise<LaunchAtLogin | null>;
    set(enabled: boolean): Promise<LaunchAtLogin | null>;
    /** Opens System Settings → General → Login Items; resolves false elsewhere or on failure. */
    openSettings(): Promise<boolean>;
  };
  /**
   * Settings' notification row: the newest notification's outcome, a test notification, and the
   * system's notification settings. Absent in shells older than it.
   */
  readonly notificationStatus?: {
    get(): Promise<NotificationStatus>;
    /** Subscribes to changes; returns the unsubscribe function. */
    onChange(callback: (status: NotificationStatus) => void): () => void;
    sendTest(): Promise<void>;
    /** Opens the system's notification settings for Gram; resolves false where it can't. */
    openSettings(): Promise<boolean>;
  };
  /**
   * The menu bar's (tray's) asks and workspace status, shown while "Keep running in the tray" (on
   * macOS, "Show in menu bar") is on. `show` replaces what this window last sent; the shell offers
   * an answer only under lines it shows whole (`trayLinesWhole`). What the user picks comes back
   * through `onAction`, to the window that sent the menu. Absent in shells older than it.
   */
  readonly tray?: {
    show(menu: TrayMenu): void;
    onAction(callback: (action: TrayAction) => void): () => void;
  };
  /** Local dictation, behind the voice input setting; absent from shells that predate it. */
  readonly speech?: DesktopSpeech;
  /** The Preview tab's page, loopback only; absent from shells that predate it. */
  readonly preview?: DesktopPreview;
  readonly updates: {
    check(channel: UpdateChannel): Promise<UpdateCheck>;
    /** Installs what `intent` names. Windows only; elsewhere resolves with an error. */
    install(intent: UpdateInstallIntent): Promise<UpdateInstallResult>;
    onProgress(callback: (progress: UpdateProgress) => void): () => void;
    /** Whether windows should check on their own at launch and while running (not in smoke or CI). */
    autoCheck(): Promise<boolean>;
    /** Where this install's updater reads releases, for Settings' copy. Absent in older shells. */
    source?(): Promise<UpdateSource>;
    readonly native?: DesktopNativeUpdates;
  };
}
