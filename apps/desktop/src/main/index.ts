import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type { DesktopBridge, MenuShortcuts, UpdateProgress } from "@gram/contracts";
import { createLogger, defaultDataDir, logDirFor } from "@gram/server/logging";
import { readUpdatePrefs } from "@gram/server/updates";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  session,
  shell,
  systemPreferences,
  utilityProcess,
} from "electron";

import { Channels } from "@gram/shell/channels";
import {
  createShellWindows,
  createWindow,
  loadLinkTrust,
  loadStoredAppearance,
  menuTemplate,
  openLink,
  themeColors,
  watchNotifications,
  watchSystemAppearance,
  watchWindow,
  type WindowContext,
} from "@gram/shell/electron";
import {
  createAgentPanes,
  decodeFrame,
  installAgentBrowse,
  servePaneMessage,
  type AgentPanes,
} from "@gram/shell/modules/agent-browser";
import { installConnection } from "@gram/shell/modules/connection";
import { installFonts } from "@gram/shell/modules/fonts";
import { installPreview, type PreviewHost } from "@gram/shell/modules/preview";
import {
  createSpeechHost,
  electronFetch,
  type ElectronNet,
  installSpeech,
  openSpeechModelStore,
  resolveSpeechModel,
  speechModelBase,
  type SpeechModelStore,
} from "@gram/shell/modules/speech";
import { createShellIpc } from "@gram/shell/modules/ipc";
import {
  fileVaultStore,
  handleVaultRequest,
  liveMacVaultReads,
  makeMacVaultCrypto,
} from "@gram/shell/modules/key-vault";
import { createTrayMode, installTray } from "@gram/shell/modules/tray";
import { APP_ID } from "./app-id.ts";
import { devAllowedOrigins, devBootUrl, logLevelFromMessage } from "./boot.ts";
import { appIconDir, createAppIcon } from "./app-icon.ts";
import { registerIpc } from "./ipc.ts";
import { createLoginItem, startsHidden } from "./login-item.ts";
import { installSmokeIpc } from "./smoke-ipc.ts";
import {
  claimSingleInstance,
  createNotificationStatus,
  grantPermission,
  permissionCheckAsk,
  permissionRequestAsk,
  isTrustedSenderUrl,
  lastWindowClosed,
  surfaceWindow,
  type ShellProduct,
} from "@gram/shell/core";
import { type PowerState, watchPower } from "./power.ts";
import { killTree, launchedPidFromMessage, type RunSync } from "./process-tree.ts";
import {
  createUpdateModelScope,
  createUpdateFinalizer,
  finalizeUpdateNative,
  waitForUpdateRecovery,
} from "./update/finalize.ts";
import { appBuildEnv, runningBuildInfo } from "./build-info.ts";
import { createSignalQuit } from "./signal-quit.ts";
import { createQuit, QUIT_DEADLINE_MS, serverShutdownFromMessage } from "./quit.ts";
import { createQuitWindow } from "./quit-window.ts";
import { createServerHost, DEFAULT_RECOVERY, NO_RECOVERY } from "./server-host.ts";
import {
  autoUpdateCheckEnabled,
  GRAM_MAC_TEAM_ID,
  judgeInstallRecord,
  macBundleTeam,
  personalMacTargets,
  unavailableUpdater,
  validTeamId,
  writableMacTarget,
  createUpdateService,
  createUpdater,
  sweepStaleUpdateDirs,
  SWEEP_MIN_AGE_MS,
  UPDATE_REPO,
  updateSource,
} from "@gram/shell/modules/update";
import { verifyNativeCandidate } from "./update/native-candidate.ts";
import { createPublicFeed, type AnonymousFetch } from "./update/native-feed.ts";
import { createElectronUpdaterPort } from "./update/native-port.ts";
import { nativeRecordStore } from "./update/native-record-store.ts";
import { createShipIt } from "./update/native-shipit.ts";
import { snapshotCandidate, sweepStaleCandidateDirs } from "./update/native-snapshot.ts";
import { createNativeUpdates, type NativeUpdates } from "./update/native-updates.ts";
import { stopForUpdate } from "./update/shutdown.ts";
import { processStart, sparedNow, watchTree, type TreeCheckDeps } from "./update/tree-check.ts";
import { probeSignature, runGh } from "./update/process.ts";
import { normaliseUserEnv } from "./user-env.ts";

const WEB_DEV_URL = process.env["GRAM_WEB_URL"] ?? "http://localhost:5173";
/** The fixed dev server port the web Vite proxy targets (see scripts/dev.mjs). */
const DEV_SERVER_PORT = process.env["GRAM_PORT"] ?? "4317";

/**
 * `--smoke`: boot the server, load its URL in a hidden window, check the speech process loads its
 * native runtime, print `SMOKE OK` and exit 0; exit 1 on a load failure, a server crash or timeout.
 * CI runs it against the packaged app.
 */
const SMOKE = process.argv.includes("--smoke");

/** What the shared shell code calls this app. */
const PRODUCT: ShellProduct = { name: "Gram" };

/** What the desktop's windows are made with: its preload, its name, and its link trust. */
const WINDOW_CONTEXT: WindowContext = {
  preloadPath: join(__dirname, "../preload/index.js"),
  title: "Gram",
  openLink,
};
const SMOKE_TIMEOUT_MS = 60_000;

// Before the data dir or anything else reads HOME. Packaged macOS only: a dev run keeps whatever
// HOME its terminal gives it.
const replacedEnv =
  process.platform === "darwin" && app.isPackaged ? normaliseUserEnv(app.getPath("temp")) : {};
const dataDir = defaultDataDir();
/** The shell's log, next to the server's; development also echoes it to stdout. */
const { logger: log } = createLogger({
  dir: logDirFor(dataDir),
  name: "desktop",
  echo: !app.isPackaged,
});
if (Object.keys(replacedEnv).length > 0) {
  log.warn(
    { replaced: replacedEnv },
    "launch environment disagreed with this account; using the account's",
  );
}

// The server's gateway keys live in safeStorage, which only main can use.
const vaultStore = fileVaultStore(join(app.getPath("userData"), "gateway-keys.json"));
const vaultCrypto = makeMacVaultCrypto(
  {
    available: () => safeStorage.isEncryptionAvailable(),
    backend: () =>
      process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : undefined,
    encrypt: (plainText: string) => safeStorage.encryptString(plainText),
    decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
  },
  process.platform,
  liveMacVaultReads(process.execPath),
);

/**
 * What the server opened for the user (an editor, a file manager), which a kill of its tree spares,
 * by pid with the start time read when it was reported: a pid since reused by another process is
 * no longer spared, and one whose start couldn't be read refuses an update's tree check.
 */
const launched = new Map<number, string | undefined>();

/** A bounded synchronous run of `ps`/PowerShell/`taskkill`; undefined if it failed to run. */
const runSync: RunSync = (file, args, timeoutMs) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return result.error === undefined ? result : undefined;
};
const treeCheckDeps: TreeCheckDeps = {
  platform: process.platform,
  run: runSync,
  signal: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Agents' pane commands, served once the app is up; until then a command finds no pane. */
let agentPanes: AgentPanes | undefined;

/** The server process (src/server); see `server-host.ts`. */
const server = createServerHost({
  fork: () =>
    utilityProcess.fork(join(__dirname, "../server/server.js"), [], {
      serviceName: "gram-server",
      stdio: "pipe",
      env: {
        ...process.env,
        GRAM_DATA_DIR: dataDir,
        GRAM_APP_VERSION: app.getVersion(),
        // Which build runs, for orchestrators to tell whether a merged fix is live yet.
        ...appBuildEnv(runningBuildInfo(app.getVersion(), app.isPackaged)),
        // Has the server prove what only a packaged build can get wrong before it reports boot.
        ...(SMOKE ? { GRAM_SMOKE: "1" } : {}),
        ...(app.isPackaged
          ? // Packaged builds serve the renderer from the server.
            { GRAM_WEB_ROOT: join(process.resourcesPath, "web") }
          : // In dev, Vite serves it and proxies `/ws` and `/?boot` to this fixed port.
            {
              GRAM_PORT: DEV_SERVER_PORT,
              GRAM_ALLOWED_ORIGINS:
                process.env["GRAM_ALLOWED_ORIGINS"] ?? devAllowedOrigins(WEB_DEV_URL),
            }),
      },
    }),
  // Unpackaged builds also accept a tokenised stdout boot line, for servers that still print one.
  bootFromStdout: !app.isPackaged,
  onMessage: (message, reply) => {
    const level = logLevelFromMessage(message);
    if (level) log.level = level;
    const shutdown = serverShutdownFromMessage(message);
    if (shutdown) quit.report(shutdown);
    const opened = launchedPidFromMessage(message);
    if (opened !== null) launched.set(opened, processStart(opened, treeCheckDeps));
    void handleVaultRequest(message, vaultCrypto, vaultStore).then((response) => {
      if (response) reply(response);
    });
    servePaneMessage(message, agentPanes, reply);
  },
  // With its agents, terminals and their children: killed outright, it can end none of them.
  forceKill: (pid) => {
    const killed = killTree(
      pid,
      {
        platform: process.platform,
        run: runSync,
        kill: (target, signal) => process.kill(target, signal),
      },
      sparedNow(launched, treeCheckDeps),
    );
    log.warn(
      { source: "server", pid, under: killed.under, names: killed.names },
      "killed the server and the processes under it",
    );
    return killed;
  },
  // An update that killed the rest of a server past its essentials replaces nothing until this
  // proves none of that tree left; what it opened for the user is spared, as from the kill.
  ...(process.platform === "win32"
    ? {}
    : {
        treeCheck: { watch: (root: number) => watchTree(root, treeCheckDeps, launched) },
      }),
  log,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  now: () => Date.now(),
  // A smoke run reports a crash rather than hiding it behind a restart.
  recovery: SMOKE ? NO_RECOVERY : DEFAULT_RECOVERY,
  // Any answer will do, a 401 included: it only asks whether the event loop still turns.
  ...(SMOKE
    ? {}
    : {
        health: {
          ping: async (url: string, timeoutMs: number) => {
            const response = await fetch(new URL("/?boot=0", url), {
              cache: "no-store",
              redirect: "manual",
              signal: AbortSignal.timeout(timeoutMs),
            });
            await response.body?.cancel();
          },
        },
      }),
});
/** Set once the smoke result is reported; later teardown errors mustn't change the exit code. */
let exiting = false;

// Automation must never stall on Electron's modal error dialog: log and exit non-zero instead.
if (SMOKE || process.env["CI"]) {
  const crash = (kind: string) => (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (exiting) {
      process.stderr.write(`ignored during exit: ${kind}: ${detail}\n`);
      return;
    }
    exiting = true;
    log.fatal({ kind, detail }, "crash");
    process.stderr.write(`${SMOKE ? "SMOKE FAIL" : "fatal"}: ${kind}: ${detail}\n`);
    server.kill("quit");
    app.exit(1);
  };
  process.on("uncaughtException", crash("uncaught exception"));
  process.on("unhandledRejection", crash("unhandled rejection"));
}

// Windows shows toasts only for the AppUserModelID the Start menu shortcut carries.
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

/** The speech process, started on the first dictation; see the shell's `modules/speech`. */
const speech = createSpeechHost({
  fork: () => {
    const child = utilityProcess.fork(join(__dirname, "../speech/speech.js"), [], {
      serviceName: "gram-speech",
      stdio: "pipe",
    });
    // Its lines are an event name and numbers (the shell's `speech-process/main.ts`); stderr is
    // the native runtime's own diagnostics.
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        log.info({ source: "speech" }, line);
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        log.warn({ source: "speech" }, line);
      });
    }
    return child;
  },
  channel: () => new MessageChannelMain(),
  resolveModel: (modelId) => resolveSpeechModel(dataDir, modelId),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  log: (fields, message) => log.info(fields, message),
});

/**
 * Local dictation's models, in `<dataDir>/speech` where the server kept them; opened by `runApp`, so
 * only the instance holding the single-instance lock recovers or writes them.
 */
let speechModels: Promise<SpeechModelStore> | undefined;
const updateFinalizer = createUpdateFinalizer();
/**
 * Set once Squirrel.Mac has staged a signed update past Gram's stop fence: the quit that follows
 * is the update's, so it exits at once and Squirrel.Mac's installer runs.
 */
let nativeUpdateQuit = false;
/** A signed install's updater, once `runApp` has made it; the quit handlers ask it. */
let nativeUpdates: NativeUpdates | undefined;
let signedUpdateStarting =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  app.isPackaged &&
  !SMOKE &&
  UPDATE_REPO !== null;
let quitAfterSignedStartup = false;

/** Quit has committed with services fenced; release any snapshot not still owned by staging. */
function exitSignedUpdate() {
  void (nativeUpdates?.dispose() ?? Promise.resolve())
    .catch((error: unknown) => log.warn({ source: "update", err: error }, "update: cleanup failed"))
    .finally(() => app.exit(0));
}

/** Brings a window forward, or opens one; set once the windows exist. */
let showWindow = () => {};
/** "Keep running in the tray", which is the menu bar item on macOS; see `tray-mode.ts`. */
const trayMode = createTrayMode({
  product: PRODUCT,
  path: join(app.getPath("userData"), "tray.json"),
  show: () => showWindow(),
  quit: () => app.quit(),
});

/** The quit, from the first ⌘Q to `app.exit`; see `quit.ts`. */
const quit = createQuit({
  steps: [
    { name: "signed update", timeoutMs: 3_000, run: async () => nativeUpdates?.dispose() },
    // The server's own bound (`STOP_TIMEOUT_MS` and a forced kill) runs past the quit's deadline.
    { name: "server", timeoutMs: QUIT_DEADLINE_MS, run: () => server.stop("quit") },
    { name: "speech", timeoutMs: 3_000, run: () => speech.shutdown() },
    // Stops a download, so its partial file is whole up to where it stopped and the next resumes.
    {
      name: "speech models",
      timeoutMs: 3_000,
      run: async () => (speechModels === undefined ? undefined : (await speechModels).close()),
    },
  ],
  terminate: () => {
    server.terminate("quit");
    speech.stop();
  },
  exit: (code) => app.exit(code),
  onProgress: (progress) => quitWindow.show(progress),
  log,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  now: () => Date.now(),
});
const quitWindow = createQuitWindow({ colors: themeColors, onForce: () => quit.force("user") });

/**
 * The boot navigation for a window, which carries the launch token to the server's own origin;
 * undefined until the server first boots. In dev it goes through Vite, so the auth cookie lands on
 * the Vite origin.
 */
const windowUrl = (): string | undefined => {
  const bootUrl = server.url();
  if (bootUrl === "") return undefined;
  return app.isPackaged || SMOKE ? bootUrl : devBootUrl(bootUrl, WEB_DEV_URL);
};

function trustedOrigins(): ReadonlySet<string> {
  const origins = new Set<string>();
  const bootUrl = server.url();
  if (bootUrl) origins.add(new URL(bootUrl).origin);
  if (!app.isPackaged) origins.add(new URL(WEB_DEV_URL).origin);
  return origins;
}

/** A fresh server has a new port and token, so every window reloads onto it. */
function reloadWindows() {
  const url = windowUrl();
  if (url === undefined) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) void win.loadURL(url);
  }
}

/** Starts the server again after a failed update launch, and reloads every window onto it. */
async function restartServer() {
  try {
    await server.start();
  } catch (error) {
    offerRecovery(error instanceof Error ? error.message : String(error));
    throw error;
  }
  reloadWindows();
}

let recoveryPrompt = false;

/**
 * Tells the user the server is down and won't come back by itself, and offers to start it again,
 * relaunch the app or quit. One prompt at a time; dismissing it tries again.
 */
function offerRecovery(problem: string) {
  if (recoveryPrompt) return;
  recoveryPrompt = true;
  void dialog
    .showMessageBox({
      type: "error",
      message: "Gram's server stopped and couldn't be restarted",
      detail:
        `The last attempt: ${problem}. Your threads and settings are saved. Try again to start ` +
        `the server, or relaunch Gram. The log is in ${logDirFor(dataDir)}.`,
      buttons: ["Try Again", "Relaunch", "Quit"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .then(({ response }) => {
      recoveryPrompt = false;
      if (response === 1) {
        // Relaunches once this instance has quit, so the single-instance lock is free by then.
        app.relaunch();
        app.quit();
      } else if (response === 2) {
        app.quit();
      } else {
        server.retry();
      }
    });
}

function broadcast(progress: UpdateProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(Channels.updatesProgress, progress);
  }
}

/** Hides every window and returns a function that shows them again. */
function hideWindows() {
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) win.hide();
  return () => {
    for (const win of allWindows) if (!win.isDestroyed()) win.show();
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One GET with no cookies, credentials or `gh`: the signed updater's public feed. A body longer
 * than `maxBytes` aborts the request.
 */
const anonymousFetch: AnonymousFetch = (url, { accept, maxBytes, redirect }) =>
  new Promise((resolve, reject) => {
    const request = net.request({
      url,
      method: "GET",
      credentials: "omit",
      useSessionCookies: false,
      redirect,
    });
    request.setHeader("Accept", accept);
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure = error;
      request.abort();
    };
    const timer = setTimeout(() => fail(new Error("timed out")), 15_000);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) fail(new Error(`GitHub's answer for ${url} is too large.`));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
      response.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(failure ?? error);
      });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(failure ?? error);
    });
    request.on("abort", () => reject(failure ?? new Error("aborted")));
    request.end();
  });

async function runApp() {
  // Before any window: open on the page background of the theme the renderer last synced.
  loadStoredAppearance(join(app.getPath("userData"), "appearance.json"));
  loadLinkTrust(join(app.getPath("userData"), "trusted-link-hosts.json"));
  const appIcon = createAppIcon({
    file: join(app.getPath("userData"), "app-icon.json"),
    dir: appIconDir(),
  });
  appIcon.start();
  const loginItem = createLoginItem({
    api: app,
    platform: process.platform,
    packaged: app.isPackaged,
    argv: process.argv,
    openExternal: (url) => shell.openExternal(url),
  });
  if (loginItem.launchedAtLogin) log.info({ source: "login" }, "launched at login");
  const notificationStatus = createNotificationStatus({
    supported: Notification.isSupported(),
    now: () => Date.now(),
    onChange: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed())
          win.webContents.send(Channels.notificationStatusChanged, status);
      }
    },
  });
  watchNotifications(notificationStatus.watch);
  const destination = dirname(dirname(dirname(app.getPath("exe"))));
  const macSupported =
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    app.isPackaged &&
    personalMacTargets().includes(destination) &&
    (await writableMacTarget(destination));
  // A Developer ID signed install updates through Electron's updater. Unsigned ones, and any whose
  // signature macOS can't read, have no in-app updater: their checks answer unavailable.
  const signedByPublisher =
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    app.isPackaged &&
    !SMOKE &&
    UPDATE_REPO !== null &&
    validTeamId(GRAM_MAC_TEAM_ID) &&
    (await macBundleTeam(destination).catch(() => undefined)) === GRAM_MAC_TEAM_ID;
  const updater =
    process.platform === "darwin"
      ? unavailableUpdater(
          app.getVersion(),
          "Only Developer ID signed builds of Gram update themselves. Install a signed release to get updates.",
        )
      : createUpdater({
          gh: runGh,
          repo: UPDATE_REPO,
          currentVersion: app.getVersion(),
          platform: process.platform,
          tempDir: tmpdir(),
          probeSignature,
          warn: (message) => log.warn({ source: "update" }, message),
          readPrefs: () => readUpdatePrefs(dataDir),
        });
  // Without handlers Electron grants every permission to every page; see `grantPermission`.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      grantPermission(
        permissionRequestAsk(permission, details, contents.getURL()),
        trustedOrigins(),
      ),
    ),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) =>
    grantPermission(permissionCheckAsk(permission, origin, details), trustedOrigins()),
  );
  const ipc = createShellIpc(ipcMain, (event) =>
    isTrustedSenderUrl(event.senderFrame?.url, trustedOrigins()),
  );
  // Reports are read from the windows made below, by then.
  const connections = installConnection(ipc, {
    log,
    windowIdFor: (sender) => windows.windowIdFor(sender),
  });
  installFonts(ipc);
  // Agents' pages are the preview's, so each asks the other: the panes create a thread's page
  // through the preview, and the preview asks the panes before an agent's page goes anywhere.
  let preview: PreviewHost | undefined;
  agentPanes = createAgentPanes({
    hosts: installAgentBrowse(ipc, {
      path: join(app.getPath("userData"), "agent-browse-hosts.json"),
      log,
    }),
    views: { contentsFor: (threadId, create) => preview?.contentsFor(threadId, create) },
    log,
    resolveHost: (host) => session.fromPartition("gram-preview").resolveHost(host),
    driverChanged: (threadId) => preview?.changed(threadId),
    decodeFrame,
  });
  preview = installPreview(ipc, { openLink, log, agent: agentPanes });
  installTray(ipc, trayMode);
  // Downloaded through Chromium's network stack (`net`), so the system proxy, PAC, Kerberos and the
  // keychain's roots apply.
  const openModels = () =>
    openSpeechModelStore({
      dataDir,
      base: speechModelBase(process.env),
      // `ElectronNet` is the slice the store uses, typed without Electron, whose overloaded
      // `ClientRequest.on` TypeScript can't match against it; the calls it makes are Electron's own.
      fetch: electronFetch(net as unknown as ElectronNet),
      log,
    });
  const modelScope = createUpdateModelScope(openModels);
  speechModels = modelScope.owned();
  const restoreNative = async () => {
    windows.cancelUpdateQuit();
    await waitForUpdateRecovery(speech.waitForUpdateExit());
    try {
      await modelScope.restore();
    } finally {
      // Ordinary quit still owns a replacement whose open finishes after recovery timeout.
      speechModels = modelScope.owned();
    }
    speech.resumeAfterUpdate();
  };
  // Its calls fail with this too; caught here so it isn't an unhandled rejection, which is fatal.
  speechModels.catch((error: unknown) => log.error({ err: error }, "speech models didn't open"));
  installSpeech(ipc, {
    host: speech,
    models: modelScope.current,
    media: systemPreferences,
    platform: process.platform,
    openExternal: (url) => shell.openExternal(url),
  });
  const windows = createShellWindows({
    url: windowUrl,
    storePath: join(app.getPath("userData"), "windows.json"),
    context: WINDOW_CONTEXT,
    startHidden: startsHidden(process.platform, loginItem.launchedAtLogin, trayMode.keepInTray()),
    onCreated: (win, windowId) => {
      win.once("closed", () => connections.forget(windowId));
      watchWindow(win, {
        windowId,
        log,
        product: PRODUCT,
        // Before the first boot there is nothing to reload; `loadPending` loads it then.
        reload: () => {
          const url = windowUrl();
          if (url !== undefined) void win.loadURL(url);
        },
      });
    },
  });
  const native =
    signedByPublisher && UPDATE_REPO !== null
      ? createSignedUpdates(UPDATE_REPO, {
          canInstall: macSupported,
          restoreNative,
          windows,
          modelScope,
        })
      : undefined;
  nativeUpdates = native;
  let menuShortcuts: MenuShortcuts = {};
  registerIpc({
    ipc,
    appIcon,
    loginItem,
    notificationStatus,
    updates: createUpdateService({
      updater,
      stopServer: () => stopForUpdate(server),
      restartServer,
      broadcast,
      hideWindows,
      exit: () => app.quit(),
      warn: (message) => log.warn({ source: "update" }, message),
    }),
    native,
    updateSource: updateSource(native ? "native" : "gh"),
    autoUpdateCheck: async () =>
      native === undefined &&
      process.platform !== "darwin" &&
      (await readUpdatePrefs(dataDir)).automaticChecks === true &&
      autoUpdateCheckEnabled({
        packaged: app.isPackaged,
        smoke: SMOKE,
        repoConfigured: UPDATE_REPO !== null,
        env: process.env,
      }),
    windows,
    setMenuShortcuts: (next) => {
      menuShortcuts = next;
      buildMenu();
    },
  });
  watchSystemAppearance();
  // A server starts out awake, so one that boots while the Mac sleeps or is locked is told so.
  let power: PowerState = "awake";
  server.onBoot(() => {
    if (power === "suspended") server.post({ type: "power", state: power });
  });
  watchPower(powerMonitor, (state) => {
    power = state;
    server.post({ type: "power", state });
  });

  const buildMenu = () =>
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        menuTemplate(
          process.platform,
          {
            send: (action) =>
              BrowserWindow.getFocusedWindow()?.webContents.send(Channels.menu, action),
            newWindow: () => {
              windows.open();
            },
            focusWindow: (windowId) => {
              windows.focus(windowId);
            },
          },
          windows.list(),
          { shortcuts: menuShortcuts, developer: !app.isPackaged },
        ),
      ),
    );
  buildMenu();
  windows.onChange(buildMenu);

  server.onRecovered(reloadWindows);
  server.onGiveUp(offerRecovery);
  // The windows, and so their renderer processes, start while the server boots. They stay hidden
  // with nothing loaded, so no page runs in them before the boot navigation takes the launch token
  // to the server's own origin, and a server that never boots leaves nothing on screen.
  const booting = server.start();
  windows.restore();
  await booting;
  // A quit asked for meanwhile has hidden the windows; loading them would show them again.
  if (quit.state() === "idle") windows.loadPending();
  void native
    ?.start()
    .catch((error: unknown) =>
      log.warn({ source: "update", err: error }, "update: the signed updater didn't start"),
    );
  signedUpdateStarting = false;
  if (quitAfterSignedStartup) app.quit();
  const openWindow = () => {
    windows.open();
  };
  showWindow = () => {
    // Nothing brings a window back once the quit has hidden them.
    if (quit.state() === "idle" && !windows.revealHeld())
      surfaceWindow(BrowserWindow.getAllWindows(), openWindow);
  };
  // A Start menu or taskbar relaunch, the way back from the tray too.
  app.on("second-instance", () => showWindow());
  trayMode.start();
  app.on("activate", () => {
    if (quit.state() !== "idle") return;
    // The Dock icon of a login launch, whose windows wait hidden.
    if (windows.revealHeld()) return;
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
  // Windows still open at quit come back at the next launch.
  app.on("before-quit", () => {
    if (!updateFinalizer.active()) windows.markQuitting();
  });

  if (process.platform === "win32") void sweepStaleUpdateDirs(tmpdir(), SWEEP_MIN_AGE_MS);
}

/**
 * Electron's updater for a signed install: the repo's public feed, read anonymously, the stop
 * fence before Squirrel.Mac's restart, and the install record that tells the next launch whether
 * the update applied.
 */
function createSignedUpdates(
  repo: string,
  deps: {
    readonly canInstall: boolean;
    readonly restoreNative: () => Promise<void>;
    readonly windows: { flushForUpdate(): void };
    readonly modelScope: { close(): Promise<void> };
  },
): NativeUpdates {
  void sweepStaleCandidateDirs(tmpdir());
  const feed = createPublicFeed({
    fetch: anonymousFetch,
    repo,
    currentVersion: app.getVersion(),
  });
  const shipIt = createShipIt({ bundleId: APP_ID, home: app.getPath("home") });
  const logHint = `Squirrel.Mac's log is ~/Library/Caches/${APP_ID}.ShipIt/ShipIt_stderr.log.`;
  const updates: NativeUpdates = createNativeUpdates({
    port: createElectronUpdaterPort({
      feed,
      shipIt,
      log: (level, line) => log[level]({ source: "update" }, line),
    }),
    currentVersion: app.getVersion(),
    canInstall: deps.canInstall,
    readPrefs: () => readUpdatePrefs(dataDir),
    timersAllowed: autoUpdateCheckEnabled({
      packaged: app.isPackaged,
      smoke: SMOKE,
      repoConfigured: true,
      env: process.env,
    }),
    verifyDownload: async (file, version, channel) => {
      // From here on only this private, descriptor-held copy counts: electron-updater's cache is
      // a shared path, and Squirrel.Mac is served the snapshot, never that path.
      const snapshot = await snapshotCandidate(file, tmpdir());
      try {
        // The feed picked the release from GitHub's API, which gives each asset's digest.
        const picked = feed.picked();
        if (picked?.version !== version)
          throw new Error("The download no longer matches the release it was checked against.");
        if (`sha256:${snapshot.sha256}` !== picked.zip.digest)
          throw new Error(
            `The downloaded ${picked.zip.name} doesn't match GitHub's SHA-256 for it.`,
          );
        // Squirrel.Mac checks only the signature against this app's requirement: notarization,
        // the staple and the version the feed offered are checked here, on the snapshot.
        if (!validTeamId(GRAM_MAC_TEAM_ID)) throw new Error("This build names no publisher team.");
        await verifyNativeCandidate({
          snapshot,
          version,
          currentVersion: app.getVersion(),
          channel,
          teamId: GRAM_MAC_TEAM_ID,
          tempDir: tmpdir(),
        });
        return snapshot;
      } catch (error) {
        await snapshot.close();
        throw error;
      }
    },
    stopForUpdate: async (signal) => {
      await updateFinalizer.own(() =>
        stopForUpdate(server, (teardown) =>
          log.info({ source: "update", ...teardown }, "update: server stopped"),
        ),
      );
      await finalizeUpdateNative(
        {
          speech: () => updateFinalizer.own(() => speech.shutdownForUpdate()),
          models: () => updateFinalizer.own(() => deps.modelScope.close()),
          windows: () => deps.windows.flushForUpdate(),
        },
        signal,
      );
    },
    transaction: async (work) => {
      if (quit.state() !== "idle") throw new Error("Gram is already quitting.");
      await updateFinalizer.run((signal) => work(signal));
    },
    recover: async () => {
      // A shutdown still settling holds recovery.
      try {
        await updateFinalizer.settle();
      } catch (error) {
        return `Recovery is on hold: ${errorText(error)}`;
      }
      const problems: string[] = [];
      try {
        await deps.restoreNative();
      } catch (error) {
        problems.push(`Voice is unavailable: ${errorText(error)}.`);
      }
      try {
        await restartServer();
      } catch (error) {
        problems.push(`The server didn't restart: ${errorText(error)}.`);
      }
      updateFinalizer.recovered();
      return problems.length ? problems.join(" ") : undefined;
    },
    armQuit: () => {
      nativeUpdateQuit = true;
    },
    disarmQuit: () => {
      nativeUpdateQuit = false;
    },
    ordinaryQuit: () => app.quit(),
    exit: exitSignedUpdate,
    hideWindows,
    record: nativeRecordStore(app.getPath("userData")),
    logHint,
    judge: (record) => judgeInstallRecord(record, app.getVersion(), Date.now(), logHint),
    broadcast: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed())
          win.webContents.send(Channels.updatesNativeChanged, state);
      }
    },
    log: (level, line) => log[level]({ source: "update" }, line),
  });
  return updates;
}

/** The Terminal tab's emulator as the packaged web app ships it, under its hashed name. */
const emulatorAsset = (): string | undefined => {
  if (!app.isPackaged) return undefined;
  const name = readdirSync(join(process.resourcesPath, "web", "assets")).find((file) =>
    /^ghostty-vt-.+\.wasm$/.test(file),
  );
  return name === undefined ? "" : `/assets/${name}`;
};

/**
 * Runs in the smoke window and returns what is wrong, "" for nothing. Besides the shell's #root it
 * compiles the terminal emulator the way the Terminal tab does, because that is the one thing in
 * the renderer that the server's CSP can refuse (`'wasm-unsafe-eval'`) and only a served page shows.
 * `asset` is undefined for an unpackaged run, whose page Vite serves with no such file to name.
 */
const smokeProbe = async (asset: string | undefined): Promise<string> => {
  if (document.getElementById("root") === null) return "the page has no #root";
  try {
    const bridge = (window as Window & { gram?: DesktopBridge }).gram;
    if (bridge === undefined) return "the page has no desktop bridge";
    const [automatic, native, tray] = await Promise.all([
      bridge.updates.autoCheck(),
      bridge.updates.native?.state(),
      bridge.keepInTray?.get(),
    ]);
    if (automatic !== false || native !== null || tray !== false)
      return "the smoke bridge didn't report updates and tray unavailable";
    if (asset === undefined) return "";
    if (asset === "") return "the web app ships no terminal emulator (ghostty-vt-*.wasm)";
    const response = await fetch(asset);
    if (!response.ok) return `the terminal emulator answered HTTP ${response.status}`;
    await WebAssembly.compile(await response.arrayBuffer());
    return "";
  } catch (error) {
    return `the smoke bridge or terminal emulator failed: ${String(error)}`;
  }
};

async function runSmoke() {
  app.dock?.hide();
  const finish = (code: number, line: string) => {
    // Killing the server rejects a pending start, which would report a second time.
    if (exiting) return;
    exiting = true;
    clearTimeout(timer);
    (code === 0 ? process.stdout : process.stderr).write(`${line}\n`);
    server.kill("smoke");
    speech.stop();
    app.exit(code);
  };
  const timer = setTimeout(
    () => finish(1, `SMOKE FAIL: the app didn't load within ${SMOKE_TIMEOUT_MS / 1000}s`),
    SMOKE_TIMEOUT_MS,
  );

  // Made before the server boots, as the app's windows are, so the smoke covers that order.
  const booting = server.start();
  installSmokeIpc(
    createShellIpc(ipcMain, (event) =>
      isTrustedSenderUrl(event.senderFrame?.url, trustedOrigins()),
    ),
    app.getVersion(),
  );
  const win = createWindow({ url: undefined, show: false, context: WINDOW_CONTEXT });
  let bootUrl: string;
  try {
    bootUrl = await booting;
  } catch (error) {
    finish(1, `SMOKE FAIL: ${String(error)}`);
    return;
  }
  server.onUnexpectedExit(({ code }) => finish(1, `SMOKE FAIL: server exited with code ${code}`));
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    // -3 (ERR_ABORTED) is a navigation superseded by the next one, not a failure.
    if (isMainFrame && code !== -3) finish(1, `SMOKE FAIL: load failed: ${description} (${code})`);
  });
  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    // A 401/404 page also "finishes loading"; only the web app's shell has #root.
    void win.webContents
      .executeJavaScript(`(${smokeProbe.toString()})(${JSON.stringify(emulatorAsset())})`)
      .then(async (problem: unknown) => {
        if (problem !== "") return finish(1, `SMOKE FAIL: ${String(problem)}`);
        // Local dictation's native addon has to load in the speech process, unpacked and signed.
        const speechRuntime = await speech.probe();
        return speechRuntime.ok
          ? finish(0, "SMOKE OK")
          : finish(1, `SMOKE FAIL: the speech runtime didn't load: ${speechRuntime.message}`);
      })
      .catch((error: unknown) => finish(1, `SMOKE FAIL: ${String(error)}`));
  });
  void win.loadURL(bootUrl);
}

// A smoke run probes a build on its own, so it neither takes nor waits for the instance lock.
const primary = SMOKE || claimSingleInstance(app);

void app
  .whenReady()
  .then(() => (!primary ? undefined : SMOKE ? runSmoke() : runApp()))
  .catch((error: unknown) => {
    log.fatal({ err: error }, "startup failed");
    console.error(error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  // A quit closes the windows on its way out; that isn't the user closing the last one. Neither is
  // Squirrel.Mac's restart, which closes them before it relaunches.
  if (quit.state() !== "idle" || nativeUpdateQuit) return;
  const next = lastWindowClosed(process.platform, trayMode.keepInTray());
  if (next === "quit") app.quit();
  else if (next === "tray") trayMode.closedToTray();
});

// Every quit (⌘Q, a menu's or the Dock's Quit, the last window closing off macOS, an update's
// relaunch) runs `quit` and ends in `app.exit`, so Electron's own quit never runs: it would close
// each window the slow way. A quit asked for while one runs forces it.
app.on("before-quit", (event) => {
  if (quit.state() === "exited") return;
  // The stop fence already ran and Squirrel.Mac staged the update: exiting runs its installer.
  if (nativeUpdateQuit) {
    event.preventDefault();
    exitSignedUpdate();
    return;
  }
  event.preventDefault();
  if (signedUpdateStarting) {
    quitAfterSignedStartup = true;
    return;
  }
  // Join launch/pending settlement before the generic cancellation route can cancel its stop.
  if (nativeUpdates?.quitNeedsFence()) {
    void nativeUpdates.quitThroughFence();
    return;
  }
  if (updateFinalizer.active()) {
    updateFinalizer.cancel();
    return;
  }
  if (quit.state() === "idle") {
    for (const win of BrowserWindow.getAllWindows()) win.hide();
  }
  quit.request();
});

// systemd and terminal shutdown follow the same backend/provider ownership fence as Quit.
if (process.platform === "linux") {
  const signalQuit = createSignalQuit(
    () => quit.state() === "idle",
    () => app.quit(),
  );
  process.on("SIGTERM", signalQuit);
  process.on("SIGINT", signalQuit);
}
