import type { TerminalId, ThreadId } from "@gram/contracts";
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
}

interface TerminalsState {
  byThread: Readonly<Record<string, ThreadTerminals>>;
  setActive: (threadId: ThreadId, terminalId: TerminalId) => void;
}

export const useTerminalsStore = create<TerminalsState>()((set) => ({
  byThread: {},
  setActive: (threadId, active) =>
    set((s) => {
      const current = s.byThread[threadId];
      return current ? { byThread: { ...s.byThread, [threadId]: { ...current, active } } } : s;
    }),
}));

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
 * Adopts the thread's live terminals, or opens its first one, in `folder` when the caller names
 * one. Idempotent while in flight.
 */
export function ensureTerminals(
  api: TerminalApi,
  threadId: ThreadId,
  folder?: string,
): Promise<void> {
  if (useTerminalsStore.getState().byThread[threadId]) return Promise.resolve();
  const pending = starting.get(threadId);
  if (pending) return pending;
  const run = (async () => {
    const alive = (await api.terminalList(threadId)).filter((t) => t.alive);
    if (alive.length > 0) {
      update(threadId, () => ({
        ids: alive.map((t) => t.terminalId),
        active: alive[0]?.terminalId,
        shells: Object.fromEntries(alive.map((t) => [t.terminalId, t.shell])),
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

const without = (
  folders: ThreadTerminals["folders"],
  terminalId: TerminalId,
): ThreadTerminals["folders"] => {
  if (folders?.[terminalId] === undefined) return folders;
  const { [terminalId]: _gone, ...rest } = folders;
  return rest;
};

/** Replaces an exited terminal with a fresh shell in the same tab, and in the same folder. */
export async function restartTerminal(
  api: TerminalApi,
  threadId: ThreadId,
  terminalId: TerminalId,
) {
  const folder = useTerminalsStore.getState().byThread[threadId]?.folders?.[terminalId];
  await api.terminalClose(terminalId).catch(() => {});
  const opened = await api.terminalOpen({
    threadId,
    ...(folder === undefined ? {} : { cwd: folder }),
    ...INITIAL_SIZE,
  });
  update(threadId, (current) => ({
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
