import {
  scriptRunState,
  type ScriptRunState,
  type TerminalId,
  type TerminalInfo,
  type ThreadId,
} from "@gram/contracts";
import { create } from "zustand";

import { errorMessage, isNotImplemented } from "@/api/errors";
import type { Api } from "@/api/types";

interface ThreadTerminals {
  ids: readonly TerminalId[];
  active: TerminalId | undefined;
  /** Each terminal's shell executable, for quoting dropped paths. */
  shells: Readonly<Record<string, string>>;
  /** The folder a terminal was asked to start in, for the ones `openTerminalIn` opened. */
  folders?: Readonly<Record<string, string>> | undefined;
  /** The project script each script tab runs, by name; its tab is named after it. */
  scripts?: Readonly<Record<string, string>> | undefined;
  /** How each script tab's run stands. */
  runs?: Readonly<Record<string, ScriptRunState>> | undefined;
}

interface TerminalsState {
  byThread: Readonly<Record<string, ThreadTerminals>>;
  setActive: (threadId: ThreadId, terminalId: TerminalId) => void;
  /** Records how a script tab's run ended, from its feed's `exit`. */
  setRun: (threadId: ThreadId, terminalId: TerminalId, run: ScriptRunState) => void;
}

export const useTerminalsStore = create<TerminalsState>()((set) => ({
  byThread: {},
  setActive: (threadId, active) =>
    set((s) => {
      const current = s.byThread[threadId];
      return current ? { byThread: { ...s.byThread, [threadId]: { ...current, active } } } : s;
    }),
  setRun: (threadId, terminalId, run) =>
    set((s) => {
      const current = s.byThread[threadId];
      if (current?.scripts?.[terminalId] === undefined || current.runs?.[terminalId] === run)
        return s;
      return {
        byThread: {
          ...s.byThread,
          [threadId]: { ...current, runs: { ...current.runs, [terminalId]: run } },
        },
      };
    }),
}));

/** How a terminal the server lists stands, for a script's tab. */
const runOf = (info: TerminalInfo): ScriptRunState =>
  info.alive
    ? "running"
    : scriptRunState({
        ...(info.exitCode === undefined ? {} : { code: info.exitCode }),
        ...(info.signal === undefined ? {} : { signal: info.signal }),
      });

const update = (threadId: ThreadId, fn: (current: ThreadTerminals) => ThreadTerminals) =>
  useTerminalsStore.setState((s) => ({
    byThread: {
      ...s.byThread,
      [threadId]: fn(s.byThread[threadId] ?? { ids: [], active: undefined, shells: {} }),
    },
  }));

export type TerminalApi = Pick<
  Api,
  | "terminalOpen"
  | "terminalInput"
  | "terminalResize"
  | "terminalClose"
  | "terminalList"
  | "terminalFeed"
>;

/** Initial size until the view has measured itself and sent `terminal.resize`. */
const INITIAL_SIZE = { cols: 80, rows: 24 };

const starting = new Map<string, Promise<void>>();

/**
 * Adopts the thread's live terminals and its scripts' runs, finished ones too, so their output
 * stays to read, or opens its first shell, in `folder` when the caller names one; with `shell`
 * false it opens none. Idempotent while in flight.
 */
export function ensureTerminals(
  api: TerminalApi,
  threadId: ThreadId,
  folder?: string,
  { shell = true }: { shell?: boolean } = {},
): Promise<void> {
  if (useTerminalsStore.getState().byThread[threadId]) return Promise.resolve();
  const pending = starting.get(threadId);
  if (pending) return pending;
  const run = (async () => {
    const kept = (await api.terminalList(threadId)).filter(
      (t) => t.alive || t.script !== undefined,
    );
    if (kept.length > 0 || !shell) {
      const scripts = kept.filter((t) => t.script !== undefined);
      update(threadId, () => ({
        ids: kept.map((t) => t.terminalId),
        active: kept[0]?.terminalId,
        shells: Object.fromEntries(kept.map((t) => [t.terminalId, t.shell])),
        ...(scripts.length === 0
          ? {}
          : {
              scripts: Object.fromEntries(scripts.map((t) => [t.terminalId, t.script!])),
              runs: Object.fromEntries(scripts.map((t) => [t.terminalId, runOf(t)])),
            }),
      }));
      return;
    }
    await openTerminal(api, threadId, folder);
  })().finally(() => starting.delete(threadId));
  starting.set(threadId, run);
  return run;
}

export async function openTerminal(
  api: TerminalApi,
  threadId: ThreadId,
  folder?: string,
): Promise<TerminalId> {
  const { terminalId, shell } = await api.terminalOpen({
    threadId,
    ...(folder === undefined ? {} : { cwd: folder }),
    ...INITIAL_SIZE,
  });
  update(threadId, (current) => ({
    ...current,
    ids: [...current.ids, terminalId],
    active: terminalId,
    shells: { ...current.shells, [terminalId]: shell },
    folders: folder === undefined ? current.folders : { ...current.folders, [terminalId]: folder },
  }));
  return terminalId;
}

/**
 * Shows a shell that started in `folder`: a live one of the thread's when there is one, else a new
 * tab. A thread's first terminal stays where it was spawned when the thread follows its agent into
 * another worktree, so "the thread's terminal" alone doesn't say which checkout it is in.
 */
export async function openTerminalIn(
  api: TerminalApi,
  threadId: ThreadId,
  folder: string,
): Promise<TerminalId> {
  await ensureTerminals(api, threadId, folder);
  const alive = (await api.terminalList(threadId)).filter((t) => t.alive);
  const entry = useTerminalsStore.getState().byThread[threadId];
  // The server reports the resolved path, which a symlinked folder doesn't compare equal to, so a
  // terminal this opened is also matched by the folder it was asked for.
  const match = alive.find(
    (t) =>
      entry?.ids.includes(t.terminalId) === true &&
      (t.cwd === folder || entry.folders?.[t.terminalId] === folder),
  );
  if (match === undefined) return openTerminal(api, threadId, folder);
  useTerminalsStore.getState().setActive(threadId, match.terminalId);
  return match.terminalId;
}

const without = <T>(
  record: Readonly<Record<string, T>> | undefined,
  terminalId: TerminalId,
): Readonly<Record<string, T>> | undefined => {
  if (record?.[terminalId] === undefined) return record;
  const { [terminalId]: _gone, ...rest } = record;
  return rest;
};

/**
 * Runs the thread's project script `name` in a tab named after it: the tab of its last run when
 * there is one, which the new run replaces, else a new one. Only a click or the script's key calls
 * this; nothing runs a script on its own.
 */
export async function runScript(
  api: TerminalApi,
  threadId: ThreadId,
  name: string,
): Promise<TerminalId> {
  await ensureTerminals(api, threadId, undefined, { shell: false });
  const opened = await api.terminalOpen({ threadId, script: name, ...INITIAL_SIZE });
  let previous: TerminalId | undefined;
  update(threadId, (current) => {
    previous = current.ids.find((id) => current.scripts?.[id] === name);
    const replaced = previous;
    return {
      ids:
        replaced === undefined
          ? [...current.ids, opened.terminalId]
          : current.ids.map((id) => (id === replaced ? opened.terminalId : id)),
      active: opened.terminalId,
      shells: { ...current.shells, [opened.terminalId]: opened.shell },
      folders: replaced === undefined ? current.folders : without(current.folders, replaced),
      scripts: {
        ...(replaced === undefined ? current.scripts : without(current.scripts, replaced)),
        [opened.terminalId]: opened.script ?? name,
      },
      runs: {
        ...(replaced === undefined ? current.runs : without(current.runs, replaced)),
        [opened.terminalId]: "running",
      },
    };
  });
  // Closed once the new run has its tab, so a run that fails to start leaves the last one's output.
  if (previous !== undefined) await api.terminalClose(previous).catch(() => {});
  return opened.terminalId;
}

/**
 * Replaces an exited terminal with a fresh shell in the same tab, and in the same folder; a
 * script's tab runs its script again.
 */
export async function restartTerminal(
  api: TerminalApi,
  threadId: ThreadId,
  terminalId: TerminalId,
) {
  const entry = useTerminalsStore.getState().byThread[threadId];
  // A script's tab runs its script again.
  const script = entry?.scripts?.[terminalId];
  if (script !== undefined) {
    await runScript(api, threadId, script);
    return;
  }
  const folder = entry?.folders?.[terminalId];
  await api.terminalClose(terminalId).catch(() => {});
  const opened = await api.terminalOpen({
    threadId,
    ...(folder === undefined ? {} : { cwd: folder }),
    ...INITIAL_SIZE,
  });
  update(threadId, (current) => ({
    ...current,
    ids: current.ids.map((id) => (id === terminalId ? opened.terminalId : id)),
    active: current.active === terminalId ? opened.terminalId : current.active,
    shells: { ...current.shells, [opened.terminalId]: opened.shell },
    folders:
      folder === undefined
        ? without(current.folders, terminalId)
        : { ...without(current.folders, terminalId), [opened.terminalId]: folder },
  }));
}

export async function closeTerminal(api: TerminalApi, threadId: ThreadId, terminalId: TerminalId) {
  update(threadId, (current) => {
    const ids = current.ids.filter((id) => id !== terminalId);
    return {
      ids,
      active: current.active === terminalId ? ids.at(-1) : current.active,
      shells: current.shells,
      folders: without(current.folders, terminalId),
      scripts: without(current.scripts, terminalId),
      runs: without(current.runs, terminalId),
    };
  });
  await api.terminalClose(terminalId).catch(() => {});
}

export function terminalProblem(error: unknown): string {
  if (isNotImplemented(error)) return "The terminal isn't available on this server yet.";
  return errorMessage(error);
}

export const resetTerminals = () => {
  starting.clear();
  useTerminalsStore.setState({ byThread: {} });
};
