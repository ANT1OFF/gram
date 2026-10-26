import { CLOSED_THREADS_LIMIT, type ClosedThread, type Thread } from "@gram/contracts";

const STORAGE_KEY = "gram.mock.closedThreads";

/**
 * The mock's closed threads, newest first. With `persist` they're kept in `localStorage`, so ⌘⇧T
 * reaches them after a reload like the server's table; tests leave it off so runs don't leak.
 */
export function createMockClosedThreads(persist: boolean) {
  const storage = persist ? globalThis.localStorage : undefined;
  let closed: ClosedThread[] = [];
  try {
    closed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]") as ClosedThread[];
  } catch {
    closed = [];
  }
  const save = () => storage?.setItem(STORAGE_KEY, JSON.stringify(closed));

  return {
    /** Threads closed in an earlier page load, which the seed mustn't bring back. */
    ids: () => new Set<string>(closed.map((entry) => entry.thread.id)),
    remember: (thread: Thread) => {
      closed = [
        { thread, closedAt: Date.now() },
        ...closed.filter((entry) => entry.thread.id !== thread.id),
      ].slice(0, CLOSED_THREADS_LIMIT);
      save();
    },
    /** Puts a taken thread back at its place by `closedAt`. */
    restore: (thread: Thread, closedAt: number) => {
      closed = [...closed.filter((entry) => entry.thread.id !== thread.id), { thread, closedAt }]
        .toSorted((a, b) => b.closedAt - a.closedAt)
        .slice(0, CLOSED_THREADS_LIMIT);
      save();
    },
    list: (): readonly ClosedThread[] => closed,
    take: (): ClosedThread | undefined => {
      const [newest, ...rest] = closed;
      closed = rest;
      save();
      return newest;
    },
  };
}
