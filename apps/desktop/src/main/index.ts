import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import {
  APP_ICONS,
  type AppUpdateState,
  type DesktopBridge,
  type MenuShortcuts,
  pagesOriginFromMessage,
  type UpdateProgress,
} from "@gram/contracts";
import { createLogger, defaultDataDir, logDirFor, securePrivateDir } from "@gram/server/logging";
import { readUpdatePrefs } from "@gram/server/updates";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
  systemPreferences,
  utilityProcess,
} from "electron";

import { Channels } from "@gram/shell/channels";
import {
  appWindows,
  createShellWindows,
  focusedAppWindow,
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
import { installPages, type PagesHost } from "@gram/shell/modules/pages";
import { installPreview, PREVIEW_PARTITIONS, type PreviewHost } from "@gram/shell/modules/preview";
import {
  createSpeechHost,
  electronFetch,
  type ElectronNet,
  installSpeech,
  openSpeechModelStore,
  resolveAccurateModels,
  resolveSpeechModel,
  speechModelBase,
  type SpeechModelStore,
} from "@gram/shell/modules/speech";
import { createShellIpc } from "@gram/shell/modules/ipc";
import {
  fileVaultStore,
  handleVaultRequest,
  type VaultCrypto,
} from "@gram/shell/modules/key-vault";
import { createTrayMode, installTray } from "@gram/shell/modules/tray";
import {
  askView,
  filterEnvironment,
  makeAskQueue,
  makeHostedDevice,
  makeWorkerMachineRelays,
  serveSentWorkMessage,
  serveWorkerMachineMessage,
  vaultSecrets,
  watchPresence,
} from "@gram/shell/modules/device";
import {
  confirmServerDialog,
  dialogDecisions,
  installHostedDeviceIpc,
  machineWord,
  makeAskWindow,
} from "@gram/shell/modules/device/main";
import {
  agentHomes,
  askColorsFor,
  createDeviceHost,
  deviceDataDir,
  embeddingFromMessage,
  machineName,
} from "./hosted-device.ts";
import { APP_ID } from "./app-id.ts";
import { devAllowedOrigins, devBootUrl, logLevelFromMessage } from "./boot.ts";
import { appIconDir, createAppIcon } from "./app-icon.ts";
import { registerIpc } from "./ipc.ts";
import { autostartExec, createLoginItem, fileAutostart, startsHidden } from "./login-item.ts";
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
import { createKeepAwake } from "./keep-awake.ts";
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
import {
  createQuit,
  keptRunningFromMessage,
  keptRunningNotice,
  QUIT_DEADLINE_MS,
  serverShutdownFromMessage,
} from "./quit.ts";
import { createQuitWindow, isProgressWindow } from "./quit-window.ts";
import { inheritedServerEnv } from "./server-env.ts";
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
import {
  locateAppImage,
  verifyAppImageCandidate,
  type AppImageLocation,
} from "./update/appimage.ts";
import { createAppImageUpdaterPort } from "./update/appimage-port.ts";
import { linuxUpdateTarget } from "./update/linux-target.ts";
import { verifyNativeCandidate } from "./update/native-candidate.ts";
import { anonymousFetch } from "./update/anonymous-fetch.ts";
import { createPublicFeed } from "./update/native-feed.ts";
import { createElectronUpdaterPort } from "./update/native-port.ts";
import { nativeRecordStore } from "./update/native-record-store.ts";
import { createShipIt } from "./update/native-shipit.ts";
import { snapshotCandidate, sweepStaleCandidateDirs } from "./update/native-snapshot.ts";
import {
  createNativeUpdates,
  type NativeUpdates,
  type NativeUpdatesOptions,
} from "./update/native-updates.ts";
import { createPackageUpdates } from "./update/package-updates.ts";
import { stopForUpdate } from "./update/shutdown.ts";
import { processStart, sparedNow, watchTree, type TreeCheckDeps } from "./update/tree-check.ts";
import { probeSignature, runGh } from "./update/process.ts";
import { normaliseUserEnv } from "./user-env.ts";
import { reloadOnto } from "./window-reload.ts";
import { setTimeout as sleep } from "node:timers/promises";

const WEB_DEV_URL = process.env["GRAM_WEB_URL"] ?? "http://localhost:5173";
const DEV_SERVER_PORT = process.env["GRAM_PORT"] ?? "4317";

const SMOKE = process.argv.includes("--smoke");

const JOURNEY = process.argv.includes("--journey");

const PRODUCT: ShellProduct = { name: "Gram" };

const WINDOW_CONTEXT: WindowContext = {
  preloadPath: join(__dirname, "../preload/index.js"),
  title: "Gram",
  openLink,
};
const SMOKE_TIMEOUT_MS = 60_000;

const replacedEnv =
  process.platform === "darwin" && app.isPackaged ? normaliseUserEnv(app.getPath("temp")) : {};
const dataDir = defaultDataDir();
const dataDirTightened = securePrivateDir(dataDir);
const { logger: log } = createLogger({
  dir: logDirFor(dataDir),
  name: "desktop",
  echo: !app.isPackaged,
});
if (dataDirTightened)
  log.warn({ dataDir }, "data folder was readable by others; made it owner-only");
if (Object.keys(replacedEnv).length > 0) {
  log.warn(
    { replaced: replacedEnv },
    "launch environment disagreed with this account; using the account's",
  );
}

const vaultStore = fileVaultStore(join(app.getPath("userData"), "gateway-keys.json"));
const vaultCrypto: VaultCrypto = {
  available: () => safeStorage.isEncryptionAvailable(),
  backend: () =>
    process.platform !== "linux"
      ? undefined
      : safeStorage.isEncryptionAvailable()
        ? safeStorage.getSelectedStorageBackend()
        : "unavailable",
  encrypt: (plainText: string) => safeStorage.encryptString(plainText),
  decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
};

let deviceChanged = (): void => undefined;
const deviceHost = createDeviceHost({
  ready: () => app.whenReady(),
  changed: () => {
    deviceChanged();
    workerMachineRelays.revalidate();
  },
  failed: (error) =>
    log.error({ source: "device", err: error }, "the personal device didn't start"),
  make: async () => {
    const files = deviceDataDir(dataDir);
    await mkdir(files, { recursive: true, mode: 0o700 });
    const presence = watchPresence(powerMonitor);
    const queue = makeAskQueue({
      surface: makeAskWindow({
        colors: () => askColorsFor(themeColors(), nativeTheme.shouldUseDarkColors),
        answered: (show, answer) => queue.answered(show, answer),
        gone: (show) => queue.gone(show),
      }),
      view: (request) => askView({ request, machine: machineWord(process.platform) }),
      notify: (view) => {
        if (Notification.isSupported())
          new Notification({ title: "Gram is asking", body: view.heading }).show();
      },
      elapsed: () => performance.now(),
    });
    const ended = () => {
      queue.close();
      presence.stop();
    };
    try {
      const device = await makeHostedDevice({
        dataDir: files,
        secrets: vaultSecrets(
          vaultCrypto,
          fileVaultStore(join(app.getPath("userData"), "device-secrets.json")),
        ),
        fetch: globalThis.fetch,
        openBrowser: (url) => shell.openExternal(url),
        confirmServer: async (server) =>
          (await dialog.showMessageBox(confirmServerDialog(server))).response === 0,
        ask: queue.ask,
        presence,
        bounds: {
          home: app.getPath("home"),
          ownFolders: [dataDir, app.getPath("userData")],
          agentHomes: agentHomes(process.env),
        },
        environment: () => {
          const filtered = filterEnvironment(process.env);
          return { env: filtered.env, secrets: filtered.secrets };
        },
        machineName: machineName(),
        platform:
          process.platform === "darwin" || process.platform === "win32"
            ? process.platform
            : "linux",
        now: () => Date.now(),
        elapsed: () => performance.now(),
        changed: () => {
          deviceChanged();
          workerMachineRelays.revalidate();
        },
      });
      return { device, end: ended };
    } catch (error) {
      ended();
      throw error;
    }
  },
});

const launched = new Map<number, string | undefined>();

const runSync: RunSync = (file, args, timeoutMs) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return result.error === undefined ? result : undefined;
};
const treeCheckDeps: TreeCheckDeps = {
  platform: process.platform,
  run: runSync,
  signal: (pid, signal) => process.kill(pid, signal),
  sleep,
  now: () => Date.now(),
};

let agentPanes: AgentPanes | undefined;

let pages: PagesHost | undefined;
let pagesOrigin: unknown;

const keepAwake = createKeepAwake(powerSaveBlocker);

const workerMachineRelays = makeWorkerMachineRelays({
  device: () => deviceHost.device(),
  post: (message) => server.post(message),
});
const server = createServerHost({
  fork: () => {
    const child = utilityProcess.fork(join(__dirname, "../server/server.js"), [], {
      serviceName: "gram-server",
      stdio: "pipe",
      env: {
        ...inheritedServerEnv(process.env, { packaged: app.isPackaged, smoke: SMOKE || JOURNEY }),
        GRAM_DATA_DIR: dataDir,
        GRAM_APP_VERSION: app.getVersion(),
        ...appBuildEnv(runningBuildInfo(app.getVersion(), app.isPackaged)),
        ...(SMOKE ? { GRAM_SMOKE: "1" } : {}),
        ...(app.isPackaged
          ? { GRAM_WEB_ROOT: join(process.resourcesPath, "web") }
          : {
              GRAM_PORT: DEV_SERVER_PORT,
              GRAM_ALLOWED_ORIGINS:
                process.env["GRAM_ALLOWED_ORIGINS"] ?? devAllowedOrigins(WEB_DEV_URL),
            }),
      },
    });
    child.on("exit", keepAwake.dispose);
    return child;
  },
  bootFromStdout: !app.isPackaged,
  onMessage: (message, reply) => {
    keepAwake.accept(message);
    const level = logLevelFromMessage(message);
    if (level) log.level = level;
    const kept = keptRunningFromMessage(message);
    if (kept !== null && Notification.isSupported())
      new Notification(keptRunningNotice(kept)).show();
    const shutdown = serverShutdownFromMessage(message);
    if (shutdown) {
      quit.report(shutdown);
      if (updateWindow.open()) updateWindow.show({ step: "server", ...shutdown });
    }
    const opened = launchedPidFromMessage(message);
    if (opened !== null) launched.set(opened, processStart(opened, treeCheckDeps));
    const embedding = embeddingFromMessage(message);
    if (embedding !== null) deviceHost.setEmbedding(embedding);
    void handleVaultRequest(message, vaultCrypto, vaultStore, process.platform).then((response) => {
      if (response) reply(response);
    });
    servePaneMessage(message, agentPanes, reply);
    serveSentWorkMessage(message, deviceHost.device(), reply);
    serveWorkerMachineMessage(message, deviceHost.device(), workerMachineRelays, reply);
    const announced = pagesOriginFromMessage(message);
    if (announced !== undefined) {
      pagesOrigin = announced;
      pages?.setOrigin(announced);
    }
  },
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
  ...(process.platform === "win32"
    ? {}
    : {
        treeCheck: { watch: (root: number) => watchTree(root, treeCheckDeps, launched) },
      }),
  log,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  now: () => Date.now(),
  recovery: SMOKE ? NO_RECOVERY : DEFAULT_RECOVERY,
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
let exiting = false;

if (SMOKE || process.env["CI"]) {
  const crash = (kind: string) => (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (exiting) {
      process.stderr.write(`ignored during exit: ${kind}: ${detail}\n`);
      return;
    }
    exiting = true;
    void deviceHost.close();
    workerMachineRelays.close();
    log.fatal({ kind, detail }, "crash");
    process.stderr.write(`${SMOKE ? "SMOKE FAIL" : "fatal"}: ${kind}: ${detail}\n`);
    server.kill("quit");
    app.exit(1);
  };
  process.on("uncaughtException", crash("uncaught exception"));
  process.on("unhandledRejection", crash("unhandled rejection"));
}

if (process.platform === "win32") app.setAppUserModelId(APP_ID);

const speech = createSpeechHost({
  fork: () => {
    const child = utilityProcess.fork(join(__dirname, "../speech/speech.js"), [], {
      serviceName: "gram-speech",
      stdio: "pipe",
    });
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
  resolveAccurate: () => resolveAccurateModels(dataDir),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  log: (fields, message) => log.info(fields, message),
});

let speechModels: Promise<SpeechModelStore> | undefined;
const updateFinalizer = createUpdateFinalizer();
let nativeUpdateQuit = false;
let nativeUpdates: NativeUpdates | undefined;
let signedUpdateStarting =
  ((process.platform === "darwin" && process.arch === "arm64") ||
    (process.platform === "linux" && process.arch === "x64")) &&
  app.isPackaged &&
  !SMOKE &&
  !JOURNEY &&
  UPDATE_REPO !== null;
let quitAfterSignedStartup = false;

function exitSignedUpdate() {
  void deviceHost
    .close()
    .then(() => nativeUpdates?.dispose())
    .catch((error: unknown) => log.warn({ source: "update", err: error }, "update: cleanup failed"))
    .finally(() => app.exit(0));
}

let showWindow = () => {};
const trayMode = createTrayMode({
  product: PRODUCT,
  path: join(app.getPath("userData"), "tray.json"),
  show: () => showWindow(),
  quit: () => app.quit(),
  ...(process.platform === "linux"
    ? {
        icon: () => {
          const image = nativeImage.createFromPath(join(appIconDir(), `${APP_ICONS[0]}.png`));
          return image.isEmpty() ? undefined : image.resize({ width: 64, height: 64 });
        },
      }
    : {}),
});

const quit = createQuit({
  steps: [
    { name: "personal device", timeoutMs: 3_000, run: () => deviceHost.close() },
    { name: "signed update", timeoutMs: 3_000, run: async () => nativeUpdates?.dispose() },
    { name: "server", timeoutMs: QUIT_DEADLINE_MS, run: () => server.stop("quit") },
    { name: "speech", timeoutMs: 3_000, run: () => speech.shutdown() },
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
const updateWindow = createQuitWindow({
  colors: themeColors,
  heading: "Restarting to update…",
  title: "Restarting Gram",
});

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

function reloadWindows() {
  const url = windowUrl();
  if (url === undefined) return;
  reloadOnto(url, appWindows(), isProgressWindow);
}

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
  for (const win of appWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(Channels.updatesProgress, progress);
  }
}

function hideWindows() {
  const allWindows = appWindows();
  for (const win of allWindows) win.hide();
  return () => {
    for (const win of allWindows) if (!win.isDestroyed()) win.show();
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function runApp() {
  loadStoredAppearance(join(app.getPath("userData"), "appearance.json"));
  loadLinkTrust(join(app.getPath("userData"), "trusted-link-hosts.json"));
  const appIcon = createAppIcon({
    file: join(app.getPath("userData"), "app-icon.json"),
    dir: appIconDir(),
  });
  appIcon.start();
  const loginExec =
    process.platform === "linux" ? autostartExec(process.env, process.execPath) : undefined;
  const loginItem = createLoginItem({
    api: app,
    platform: process.platform,
    packaged: app.isPackaged,
    argv: process.argv,
    openExternal: (url) => shell.openExternal(url),
    ...(loginExec === undefined
      ? {}
      : {
          autostart: fileAutostart(
            join(app.getPath("appData"), "autostart", "gram.desktop"),
            loginExec,
          ),
        }),
  });
  if (loginItem.launchedAtLogin) log.info({ source: "login" }, "launched at login");
  const notificationStatus = createNotificationStatus({
    supported: Notification.isSupported(),
    now: () => Date.now(),
    onChange: (status) => {
      for (const win of appWindows()) {
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
  const signedByPublisher =
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    app.isPackaged &&
    !SMOKE &&
    !JOURNEY &&
    UPDATE_REPO !== null &&
    validTeamId(GRAM_MAC_TEAM_ID) &&
    (await macBundleTeam(destination).catch(() => undefined)) === GRAM_MAC_TEAM_ID;
  const appImage =
    process.platform === "linux" ? await locateAppImage(process.env, process.execPath) : undefined;
  const linuxTarget = linuxUpdateTarget({
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    smoke: SMOKE || JOURNEY,
    repo: UPDATE_REPO,
    appImage,
  });
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
  deviceChanged = installHostedDeviceIpc(ipc, {
    device: () => deviceHost.device(),
    decisions: (sender) =>
      dialogDecisions(() => {
        const win = BrowserWindow.fromWebContents(sender);
        return win === null || win.isDestroyed() ? undefined : win;
      }),
    machine: machineWord(process.platform),
  }).changed;
  const connections = installConnection(ipc, {
    log,
    windowIdFor: (sender) => windows.windowIdFor(sender),
    renewSession: (sender) => {
      const url = windowUrl();
      const win = BrowserWindow.fromWebContents(sender);
      if (url === undefined || win === null || win.isDestroyed() || isProgressWindow(win))
        return false;
      void win.loadURL(url);
      return true;
    },
  });
  installFonts(ipc);
  let preview: PreviewHost | undefined;
  agentPanes = createAgentPanes({
    hosts: installAgentBrowse(ipc, {
      path: join(app.getPath("userData"), "agent-browse-hosts.json"),
      log,
    }),
    views: { contentsFor: (threadId, create) => preview?.contentsFor(threadId, create) },
    log,
    resolveHost: (host) => session.fromPartition(PREVIEW_PARTITIONS.local).resolveHost(host),
    driverChanged: (threadId) => preview?.changed(threadId),
    decodeFrame,
  });
  preview = installPreview(ipc, { openLink, log, agent: agentPanes, appOrigins: trustedOrigins });
  pages = installPages(ipc, {
    log,
    guardPreload: join(__dirname, "../page-guard/page-guard.js"),
  });
  if (pagesOrigin !== undefined) pages.setOrigin(pagesOrigin);
  installTray(ipc, trayMode);
  const openModels = () =>
    openSpeechModelStore({
      dataDir,
      base: speechModelBase(process.env),
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
      speechModels = modelScope.owned();
    }
    speech.resumeAfterUpdate();
  };
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
        reload: () => {
          const url = windowUrl();
          if (url !== undefined) void win.loadURL(url);
        },
      });
    },
  });
  const fenced = { restoreNative, windows, modelScope };
  const native =
    UPDATE_REPO === null
      ? undefined
      : signedByPublisher
        ? createSignedUpdates(UPDATE_REPO, { ...fenced, canInstall: macSupported })
        : linuxTarget === "appimage" && appImage
          ? createAppImageUpdates(UPDATE_REPO, appImage, fenced)
          : linuxTarget === "deb"
            ? createDebUpdates(UPDATE_REPO)
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
      stopServer: async () => {
        await deviceHost.stop();
        return stopForUpdate(server);
      },
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
        smoke: SMOKE || JOURNEY,
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
            send: (action) => focusedAppWindow()?.webContents.send(Channels.menu, action),
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
  const booting = server.start();
  windows.restore();
  await booting;
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
    if (quit.state() === "idle" && !windows.revealHeld()) surfaceWindow(appWindows(), openWindow);
  };
  app.on("second-instance", () => showWindow());
  trayMode.start();
  app.on("activate", () => {
    if (quit.state() !== "idle") return;
    if (windows.revealHeld()) return;
    if (appWindows().length === 0) openWindow();
  });
  app.on("before-quit", () => {
    if (!updateFinalizer.active()) windows.markQuitting();
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    log.warn(
      {
        source: "app",
        type: details.type,
        serviceName: details.serviceName,
        reason: details.reason,
        exitCode: details.exitCode,
      },
      "a helper process went away",
    );
  });

  if (process.platform === "win32") void sweepStaleUpdateDirs(tmpdir(), SWEEP_MIN_AGE_MS);
}

interface FencedDeps {
  readonly restoreNative: () => Promise<void>;
  readonly windows: { flushForUpdate(): void };
  readonly modelScope: { close(): Promise<void> };
}

function fencedUpdateOptions(
  deps: FencedDeps,
): Omit<
  NativeUpdatesOptions,
  "port" | "target" | "currentVersion" | "canInstall" | "verifyDownload" | "logHint" | "judge"
> {
  return {
    readPrefs: () => readUpdatePrefs(dataDir),
    timersAllowed: autoUpdateCheckEnabled({
      packaged: app.isPackaged,
      smoke: SMOKE || JOURNEY,
      repoConfigured: true,
      env: process.env,
    }),
    stopForUpdate: async (signal) => {
      await deviceHost.stop();
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
    transaction: async (work, retry) => {
      if (quit.state() !== "idle") throw new Error("Gram is already quitting.");
      await updateFinalizer.run((signal) => work(signal), retry);
    },
    recover: async () => {
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
    hideWindows: () => {
      const restore = hideWindows();
      updateWindow.show("Stopping threads and agents…");
      return () => {
        restore();
        updateWindow.close();
      };
    },
    progress: (detail) => updateWindow.show(detail),
    record: nativeRecordStore(app.getPath("userData")),
    broadcast: broadcastNativeUpdate,
    log: (level, line) => log[level]({ source: "update" }, line),
  };
}

const broadcastNativeUpdate = (state: AppUpdateState) => {
  for (const win of appWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(Channels.updatesNativeChanged, state);
  }
};

function createSignedUpdates(
  repo: string,
  deps: FencedDeps & { readonly canInstall: boolean },
): NativeUpdates {
  void sweepStaleCandidateDirs(tmpdir());
  const feed = createPublicFeed({
    fetch: anonymousFetch,
    repo,
    currentVersion: app.getVersion(),
  });
  const shipIt = createShipIt({ bundleId: APP_ID, home: app.getPath("home") });
  const logHint = `Squirrel.Mac's log is ~/Library/Caches/${APP_ID}.ShipIt/ShipIt_stderr.log.`;
  return createNativeUpdates({
    ...fencedUpdateOptions(deps),
    port: createElectronUpdaterPort({
      feed,
      shipIt,
      log: (level, line) => log[level]({ source: "update" }, line),
    }),
    target: "mac",
    currentVersion: app.getVersion(),
    canInstall: deps.canInstall,
    verifyDownload: async (file, version, channel) => {
      const snapshot = await snapshotCandidate(file, tmpdir());
      try {
        const picked = feed.picked();
        if (picked?.version !== version)
          throw new Error("The download no longer matches the release it was checked against.");
        if (`sha256:${snapshot.sha256}` !== picked.payload.digest)
          throw new Error(
            `The downloaded ${picked.payload.name} doesn't match GitHub's SHA-256 for it.`,
          );
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
    logHint,
    judge: (record) => judgeInstallRecord(record, app.getVersion(), Date.now(), logHint),
  });
}

function createAppImageUpdates(
  repo: string,
  appImage: AppImageLocation,
  deps: FencedDeps,
): NativeUpdates {
  void sweepStaleCandidateDirs(tmpdir());
  const feed = createPublicFeed({
    fetch: anonymousFetch,
    repo,
    currentVersion: app.getVersion(),
    target: "appimage",
  });
  const logHint = `The update replaced ${appImage.path}; open that file to run it.`;
  return createNativeUpdates({
    ...fencedUpdateOptions(deps),
    port: createAppImageUpdaterPort({
      feed,
      appImage: appImage.path,
      relaunch: (path) => {
        app.relaunch({ execPath: path });
        app.quit();
      },
      log: (level, line) => log[level]({ source: "update" }, line),
    }),
    target: "appimage",
    currentVersion: app.getVersion(),
    canInstall: appImage.writable,
    verifyDownload: async (file, version, channel) => {
      const snapshot = await snapshotCandidate(file, tmpdir());
      try {
        const picked = feed.picked();
        if (picked?.version !== version)
          throw new Error("The download no longer matches the release it was checked against.");
        await verifyAppImageCandidate({
          snapshot,
          version,
          currentVersion: app.getVersion(),
          channel,
          expected: {
            sha512: feed.pickedSha512(),
            digest: picked.payload.digest,
            size: picked.payload.size,
          },
        });
        return snapshot;
      } catch (error) {
        await snapshot.close();
        throw error;
      }
    },
    logHint,
    judge: (record) =>
      judgeInstallRecord(record, app.getVersion(), Date.now(), logHint, "appimage"),
  });
}

function createDebUpdates(repo: string): NativeUpdates {
  const feed = createPublicFeed({
    fetch: anonymousFetch,
    repo,
    currentVersion: app.getVersion(),
    target: "deb",
  });
  return createPackageUpdates({
    feed,
    repo,
    currentVersion: app.getVersion(),
    readPrefs: () => readUpdatePrefs(dataDir),
    timersAllowed: autoUpdateCheckEnabled({
      packaged: app.isPackaged,
      smoke: SMOKE || JOURNEY,
      repoConfigured: true,
      env: process.env,
    }),
    ordinaryQuit: () => app.quit(),
    broadcast: broadcastNativeUpdate,
    log: (level, line) => log[level]({ source: "update" }, line),
  });
}

const emulatorAsset = (): string | undefined => {
  if (!app.isPackaged) return undefined;
  const name = readdirSync(join(process.resourcesPath, "web", "assets")).find((file) =>
    /^ghostty-vt-.+\.wasm$/.test(file),
  );
  return name === undefined ? "" : `/assets/${name}`;
};

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
    if (isMainFrame && code !== -3) finish(1, `SMOKE FAIL: load failed: ${description} (${code})`);
  });
  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    void win.webContents
      .executeJavaScript(`(${smokeProbe.toString()})(${JSON.stringify(emulatorAsset())})`)
      .then(async (problem: unknown) => {
        if (problem !== "") return finish(1, `SMOKE FAIL: ${String(problem)}`);
        const speechRuntime = await speech.probe();
        return speechRuntime.ok
          ? finish(0, "SMOKE OK")
          : finish(1, `SMOKE FAIL: the speech runtime didn't load: ${speechRuntime.message}`);
      })
      .catch((error: unknown) => finish(1, `SMOKE FAIL: ${String(error)}`));
  });
  void win.loadURL(bootUrl);
}

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
  if (quit.state() !== "idle" || nativeUpdateQuit) return;
  const next = lastWindowClosed(process.platform, trayMode.keepInTray());
  if (next === "quit") app.quit();
  else if (next === "tray") trayMode.closedToTray();
});

app.on("before-quit", (event) => {
  if (quit.state() === "exited") return;
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
  if (nativeUpdates?.quitNeedsFence()) {
    void nativeUpdates.quitThroughFence();
    return;
  }
  if (updateFinalizer.active()) {
    updateFinalizer.cancel();
    return;
  }
  if (quit.state() === "idle") {
    for (const win of appWindows()) win.hide();
  }
  quit.request();
});

if (process.platform === "linux") {
  const signalQuit = createSignalQuit(
    () => quit.state() === "idle",
    () => app.quit(),
  );
  process.on("SIGTERM", signalQuit);
  process.on("SIGINT", signalQuit);
}
