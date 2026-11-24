import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";

import { displayCommand, fieldsOf } from "@gram/contracts";
import type {
  HostedDeviceActivity,
  HostedDeviceDone,
  HostedDeviceView,
} from "@gram/contracts/desktop-bridge";
import { BrowserWindow, dialog, type MessageBoxOptions, type WebContents } from "electron";

import { Channels } from "../../channels.ts";
import { appWindows, isDecisionWindow } from "../../electron/decision-windows.ts";
import type { ShellIpc } from "../ipc.ts";
import type { HostedDevice, HostedDeviceState, LendChoice } from "./hosted-device.ts";
import { hostedThreadIdOf, workMessageOf, workToSendOf, workWaitOf } from "./work-input.ts";

export { isDecisionWindow, makeAskWindow } from "./ask-window.ts";
export { workToSendOf, workWaitOf, workMessageOf } from "./work-input.ts";
export { makeSiteWindows, type SiteWindows } from "./site-window.ts";

/**
 * A server's own words on one line, as a dialog the shell draws shows them: codes nobody could
 * see (bidirectional, zero-width, control) drawn as their codes and line breaks as spaces, so the
 * words can't reorder or add to the dialog's own. Whether they had such codes, or letters outside
 * ASCII that may be look-alikes, is said beside them.
 */
export const serverWords = (text: string): { readonly text: string; readonly unusual: boolean } => {
  const display = displayCommand(text);
  return {
    text: display.pieces
      .map((piece) => (piece.kind === "newline" ? " " : piece.text))
      .join("")
      .replace(/\s+/g, " ")
      .trim(),
    unusual: display.hidden || display.nonAscii,
  };
};

const UNUSUAL = "Its name has characters you can't see, or letters that may look like others.";

/** "this Mac" or "this computer". */
export const machineWord = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "this Mac" : "this computer";

/** The dialog that asks the person to accept a server they haven't signed in to before. */
export const confirmServerDialog = (server: {
  readonly origin: string;
  readonly name: string;
}): MessageBoxOptions & { detail: string } => {
  const name = serverWords(server.name);
  return {
    type: "question",
    title: "Sign in to a server",
    message: `Sign in to ${server.origin}?`,
    detail: [
      "Once you lend it this computer, it can ask to run commands and read files in the " +
        "folders you lend. You approve each.",
      "",
      `The server names itself: ${name.text}`,
      ...(name.unusual ? [UNUSUAL] : []),
    ].join("\n"),
    buttons: ["Sign in", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
};

type Workspace = HostedDeviceState["servers"][number]["workspaces"][number];

const workspaceLines = (origin: string, workspace: Workspace): Array<string> => {
  const name = serverWords(workspace.name);
  const organisation = serverWords(workspace.organisation);
  return [
    `Workspace: ${name.text}`,
    `Organisation: ${organisation.text}`,
    `Server: ${origin}`,
    ...(name.unusual || organisation.unusual
      ? [UNUSUAL.replace("Its name has", "These have")]
      : []),
  ];
};

const pathWords = (path: string): { readonly text: string; readonly unusual: boolean } => {
  const words = serverWords(path);
  const spaced = displayCommand(path)
    .pieces.map((piece) => (piece.kind === "newline" ? " " : piece.text))
    .join("");
  return { text: words.text, unusual: words.unusual || spaced !== words.text };
};

const folderLines = (paths: ReadonlyArray<string>): Array<string> => {
  const drawn = paths.map(pathWords);
  return [
    ...drawn.map((path) => path.text),
    ...(drawn.some((path) => path.unusual)
      ? ["A folder's name has characters you can't see, or letters that may look like others."]
      : []),
  ];
};

const resumesReadOnly = (workspace: Workspace): boolean =>
  workspace.readOnly || workspace.policy === "read";

/** The dialog that confirms the folders the person picked, and whether commands may run. */
export const lendDialog = (
  origin: string,
  workspace: Workspace,
  paths: ReadonlyArray<string>,
  machine: string,
): MessageBoxOptions & { detail: string } => ({
  type: "question",
  title: `Lend ${machine}`,
  message: `Lend ${paths.length === 1 ? "this folder" : `these ${paths.length} folders`}?`,
  detail: [
    ...workspaceLines(origin, workspace),
    "",
    ...folderLines(paths),
    "",
    workspace.policy === "read"
      ? "The organisation allows reading files here, not commands. Each read asks you first."
      : "Threads there can ask to run commands and read files in these folders. Each asks you " +
        "first, while you are at this computer.",
  ].join("\n"),
  buttons: ["Lend", "Cancel"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  ...(workspace.policy === "read"
    ? {}
    : { checkboxLabel: "Reads only: no commands", checkboxChecked: false }),
});

/** The dialog that confirms lending again what was lent before the app last quit. */
export const resumeDialog = (
  origin: string,
  workspace: Workspace,
  machine: string,
): MessageBoxOptions & { detail: string } => ({
  type: "question",
  title: `Resume lending ${machine}`,
  message: "Lend these folders again?",
  detail: [
    ...workspaceLines(origin, workspace),
    "",
    ...folderLines(workspace.folders.map((folder) => folder.path)),
    "",
    resumesReadOnly(workspace)
      ? "Reads only. Each asks you first."
      : "Commands and reads. Each asks you first.",
  ].join("\n"),
  buttons: ["Resume", "Cancel"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
});

/** The dialog that lifts a server's pause, after requests went refused or unanswered. */
export const liftPauseDialog = (origin: string): MessageBoxOptions & { detail: string } => ({
  type: "warning",
  title: "Lending is paused",
  message: `Let ${origin} ask again?`,
  detail:
    "Lending to this server paused after three requests in a row were refused or went " +
    "unanswered. Lift the pause only if you expect it to ask.",
  buttons: ["Lift the pause", "Keep the pause"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
});

/** The dialog that sets edited lending settings aside. */
export const startAfreshDialog = (): MessageBoxOptions & { detail: string } => ({
  type: "warning",
  title: "Lending settings were changed",
  message: "Set them aside and start with nothing lent?",
  detail:
    "The lending settings were changed outside Gram, so nothing is lent. Gram keeps the " +
    "changed file and its log beside the new ones.",
  buttons: ["Start afresh", "Cancel"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
});

/** How the shell asks; dialogs in the app, fakes in tests. */
export interface DeviceDecisions {
  readonly ask: (
    options: MessageBoxOptions,
  ) => Promise<{ readonly response: number; readonly checkboxChecked: boolean }>;
  readonly pickFolders: (title: string) => Promise<ReadonlyArray<string> | undefined>;
}

/** Dialogs drawn by the operating system, attached to the window that asked when there is one. */
export const dialogDecisions = (parent: () => BrowserWindow | undefined): DeviceDecisions => ({
  ask: (options) => {
    const win = parent();
    return win === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(win, options);
  },
  pickFolders: async (title) => {
    const options = {
      title,
      buttonLabel: "Choose",
      properties: ["openDirectory", "multiSelections"] as Array<
        "openDirectory" | "multiSelections"
      >,
    };
    const win = parent();
    const picked =
      win === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(win, options);
    return picked.canceled ? undefined : picked.filePaths;
  },
});

const NONE: HostedDeviceDone = { ok: false, why: "Hosted features are off." };
const CANCELLED: HostedDeviceDone = { ok: false, why: "Cancelled." };

const text = (value: unknown, most: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= most ? value : undefined;

const field = (arg: unknown, name: string, most: number): string | undefined =>
  text(fieldsOf(arg).get(name), most);

/** The device's decisions, put to the person: each answers only what they chose. */
export const deviceDecisionsFor = (
  device: HostedDevice,
  decisions: DeviceDecisions,
  machine: string,
) => {
  const workspaceOf = (origin: string, id: string) =>
    device
      .state()
      .servers.find((server) => server.origin === origin)
      ?.workspaces.find((workspace) => workspace.id === id);

  return {
    lend: async (origin: string, id: string): Promise<HostedDeviceDone> => {
      const workspace = workspaceOf(origin, id);
      if (workspace === undefined) return { ok: false, why: "No such workspace." };
      if (workspace.policy === "off")
        return { ok: false, why: "The organisation doesn't allow lending to this workspace." };
      const picked = await decisions.pickFolders(
        `Folders to lend to ${serverWords(workspace.name).text}`,
      );
      if (picked === undefined || picked.length === 0) return CANCELLED;
      let paths: Array<string>;
      let seen: Array<{ device: number; inode: number }>;
      try {
        paths = await Promise.all(picked.map((path) => realpath(path)));
        seen = await Promise.all(
          paths.map(async (path) => {
            const stats = await stat(path);
            return { device: stats.dev, inode: stats.ino };
          }),
        );
      } catch {
        return { ok: false, why: "Gram can't open a folder you chose." };
      }
      const answer = await decisions.ask(lendDialog(origin, workspace, paths, machine));
      if (answer.response !== 0) return CANCELLED;
      const choice: LendChoice = {
        folders: paths.map((path, index) => ({
          path,
          label: basename(path) || path,
          seen: seen[index]!,
        })),
        readOnly: workspace.policy === "read" || answer.checkboxChecked,
      };
      return device.lend(origin, id, choice);
    },
    resume: async (origin: string, id: string): Promise<HostedDeviceDone> => {
      const workspace = workspaceOf(origin, id);
      if (workspace === undefined || workspace.lending !== "resume")
        return { ok: false, why: "Nothing to resume." };
      const answer = await decisions.ask(resumeDialog(origin, workspace, machine));
      return answer.response === 0
        ? device.resume(origin, id, {
            folders: workspace.folders.map((folder) => folder.id),
            readOnly: resumesReadOnly(workspace),
          })
        : CANCELLED;
    },
    liftPause: async (origin: string): Promise<HostedDeviceDone> => {
      const server = device.state().servers.find((each) => each.origin === origin);
      if (server === undefined || !server.paused) return { ok: false, why: "Not paused." };
      const answer = await decisions.ask(liftPauseDialog(origin));
      if (answer.response !== 0) return CANCELLED;
      await device.liftPause(origin);
      return { ok: true };
    },
    startAfresh: async (): Promise<HostedDeviceDone> => {
      if (device.state().unavailable !== "settings-edited")
        return { ok: false, why: "There is nothing to set aside." };
      const answer = await decisions.ask(startAfreshDialog());
      return answer.response === 0 ? device.startAfresh() : CANCELLED;
    },
  };
};

const ACTIVITY_MOST = 200;

const fromApp = (sender: WebContents) => {
  const win = BrowserWindow.fromWebContents(sender);
  return win === null || !isDecisionWindow(win);
};

const target = (arg: unknown) => ({
  origin: field(arg, "origin", 512),
  workspace: field(arg, "workspace", 128),
});

const threadIdOf = (arg: unknown): string | undefined => {
  const id = field(arg, "threadId", 128);
  return id !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
};

export interface HostedDeviceIpcOptions {
  readonly device: () => HostedDevice | undefined;
  /** The dialogs, attached to the window that asked. */
  readonly decisions: (sender: WebContents) => DeviceDecisions;
  readonly machine: string;
  /** Opens a server's site for a workspace in its window (`site-window.ts`). */
  readonly openSite?: (origin: string, workspace: string, page: string) => void;
}

/**
 * Serves `hostedDevice` to the app's own pages. Each call is checked: strings of bounded length,
 * and never from a decision window. A decision is put to the person before anything changes.
 */
export const installHostedDeviceIpc = (ipc: ShellIpc, options: HostedDeviceIpcOptions) => {
  type Handler = (arg: unknown, sender: WebContents) => unknown;
  const serve = (channel: string, handler: Handler) =>
    ipc.handle(channel, (arg, event) => {
      if (!fromApp(event.sender)) throw new Error("untrusted sender");
      return handler(arg, event.sender);
    });
  const withDevice =
    (run: (device: HostedDevice, arg: unknown, sender: WebContents) => unknown) =>
    (arg: unknown, sender: WebContents) => {
      const device = options.device();
      return device === undefined ? NONE : run(device, arg, sender);
    };
  const decide = (device: HostedDevice, sender: WebContents) =>
    deviceDecisionsFor(device, options.decisions(sender), options.machine);

  serve(
    Channels.hostedDeviceState,
    (): HostedDeviceView | null => options.device()?.state() ?? null,
  );
  serve(
    Channels.hostedDeviceSignIn,
    withDevice((device, arg) => {
      const server = field(arg, "server", 2048);
      return server === undefined
        ? { ok: false, why: "Type the server's address." }
        : device.signIn(server);
    }),
  );
  serve(
    Channels.hostedDeviceSignOut,
    withDevice((device, arg) => {
      const { origin } = target(arg);
      return origin === undefined ? undefined : device.signOut(origin);
    }),
  );
  serve(
    Channels.hostedDeviceRefresh,
    withDevice((device, arg) => {
      const { origin } = target(arg);
      return origin === undefined ? NONE : device.refresh(origin);
    }),
  );
  serve(
    Channels.hostedDeviceMoveThread,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      const bundle =
        typeof arg === "object" && arg !== null && "bundle" in arg ? arg.bundle : undefined;
      return origin === undefined || workspace === undefined || bundle === undefined
        ? { ok: false, why: "Name the server, the workspace and the thread." }
        : device
            .moveThread(origin, workspace, bundle)
            .then((moved) =>
              moved.ok
                ? { ...moved, notes: moved.notes.map((note) => serverWords(note).text) }
                : { ...moved, why: serverWords(moved.why).text },
            );
    }),
  );
  serve(
    Channels.hostedDeviceFetchThread,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      const threadId = threadIdOf(arg);
      return origin === undefined || workspace === undefined || threadId === undefined
        ? { ok: false, why: "Name the server, the workspace and the thread." }
        : device
            .fetchThread(origin, workspace, threadId)
            .then((fetched) =>
              fetched.ok ? fetched : { ...fetched, why: serverWords(fetched.why).text },
            );
    }),
  );
  serve(
    Channels.hostedDeviceSettleThread,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      const threadId = threadIdOf(arg);
      const exportedAt =
        typeof arg === "object" && arg !== null && "exportedAt" in arg ? arg.exportedAt : undefined;
      return origin === undefined ||
        workspace === undefined ||
        threadId === undefined ||
        typeof exportedAt !== "number" ||
        !Number.isFinite(exportedAt)
        ? { ok: false, why: "Name the server, the workspace, the thread and its export." }
        : device
            .settleThread(origin, workspace, threadId, exportedAt)
            .then((settled) =>
              settled.ok ? settled : { ...settled, why: serverWords(settled.why).text },
            );
    }),
  );
  serve(
    Channels.hostedDeviceSendWork,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      const work = workToSendOf(arg);
      return origin === undefined || workspace === undefined || work === undefined
        ? { ok: false, why: "Name the server, the workspace, the repositories and the task." }
        : device
            .sendWork(origin, workspace, work)
            .then((sent) => (sent.ok ? sent : { ...sent, why: serverWords(sent.why).text }));
    }),
  );
  serve(
    Channels.hostedDeviceWaitWork,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      const threadId = hostedThreadIdOf(arg);
      const wait = workWaitOf(arg);
      return origin === undefined ||
        workspace === undefined ||
        threadId === undefined ||
        wait === undefined
        ? { ok: false, why: "Name the server, the workspace and the thread." }
        : device.waitWork(origin, workspace, threadId, wait).then((waited) =>
            waited.ok
              ? {
                  ok: true,
                  happened: waited.waited.happened,
                  ...(waited.waited.latest === undefined ? {} : { latest: waited.waited.latest }),
                  ...(waited.waited.reply === undefined ? {} : { reply: waited.waited.reply }),
                  title: serverWords(waited.waited.thread.title).text,
                  state: waited.waited.thread.state,
                  working: waited.waited.thread.working,
                }
              : { ...waited, why: serverWords(waited.why).text },
          );
    }),
  );
  serve(
    Channels.hostedDeviceMessageWork,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      const threadId = hostedThreadIdOf(arg);
      const message = workMessageOf(arg);
      return origin === undefined ||
        workspace === undefined ||
        threadId === undefined ||
        message === undefined
        ? { ok: false, why: "Name the server, the workspace, the thread and the message." }
        : device
            .messageWork(origin, workspace, threadId, message)
            .then((sent) => (sent.ok ? sent : { ...sent, why: serverWords(sent.why).text }));
    }),
  );
  serve(
    Channels.hostedDeviceStopWork,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      const threadId = hostedThreadIdOf(arg);
      return origin === undefined || workspace === undefined || threadId === undefined
        ? { ok: false, why: "Name the server, the workspace and the thread." }
        : device
            .stopWork(origin, workspace, threadId)
            .then((done) => (done.ok ? done : { ...done, why: serverWords(done.why).text }));
    }),
  );
  serve(
    Channels.hostedDeviceStop,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      return origin === undefined || workspace === undefined
        ? undefined
        : device.stop(origin, workspace);
    }),
  );
  serve(
    Channels.hostedDeviceLend,
    withDevice((device, arg, sender) => {
      const { origin, workspace } = target(arg);
      return origin === undefined || workspace === undefined
        ? NONE
        : decide(device, sender).lend(origin, workspace);
    }),
  );
  serve(
    Channels.hostedDeviceResume,
    withDevice((device, arg, sender) => {
      const { origin, workspace } = target(arg);
      return origin === undefined || workspace === undefined
        ? NONE
        : decide(device, sender).resume(origin, workspace);
    }),
  );
  serve(
    Channels.hostedDeviceLiftPause,
    withDevice((device, arg, sender) => {
      const { origin } = target(arg);
      return origin === undefined ? NONE : decide(device, sender).liftPause(origin);
    }),
  );
  serve(
    Channels.hostedDeviceStartAfresh,
    withDevice((device, _arg, sender) => decide(device, sender).startAfresh()),
  );

  serve(
    Channels.hostedDeviceOpenSite,
    withDevice((device, arg) => {
      const { origin, workspace } = target(arg);
      const page =
        origin === undefined || workspace === undefined
          ? undefined
          : device.sitePage(origin, workspace);
      if (origin === undefined || workspace === undefined || page === undefined)
        return { ok: false, why: "Gram doesn't know that workspace there." };
      if (options.openSite === undefined)
        return { ok: false, why: "This app can't open the server's site." };
      options.openSite(origin, workspace, page);
      return { ok: true };
    }),
  );
  serve(Channels.hostedDeviceActivity, async (): Promise<HostedDeviceActivity | null> => {
    const device = options.device();
    if (device === undefined) return null;
    const read = await device.activity(ACTIVITY_MOST);
    return {
      kept: read.kept,
      intact: read.intact,
      setAside: read.setAside,
      more: read.more,
      entries: read.entries.map(({ thread: _thread, ...shown }) => shown),
    };
  });

  return {
    changed: () => {
      for (const win of appWindows())
        if (!win.webContents.isDestroyed())
          win.webContents.send(Channels.hostedDeviceChanged, null);
    },
  };
};
