import type { ServerEvent, Thread, ThreadId } from "@gram/contracts";

/**
 * A filter for a hub subscriber that reads only some of a thread: it passes a `thread.upsert` only
 * when `key` reads differently for that thread than at the last upsert it passed, so an upsert of
 * fields the subscriber never reads (a turn's `lastActivityAt`, `unread`) costs it nothing. The
 * first upsert of each thread passes, `thread.removed` passes and forgets the thread, and every
 * other event passes. One filter per subscription: it remembers what that one was shown.
 */
export const upsertsChanging = (key: (thread: Thread) => string) => {
  const last = new Map<ThreadId, string>();
  return (event: ServerEvent): boolean => {
    if (event.type === "thread.removed") {
      last.delete(event.threadId);
      return true;
    }
    if (event.type !== "thread.upsert") return true;
    const next = key(event.thread);
    if (last.get(event.thread.id) === next) return false;
    last.set(event.thread.id, next);
    return true;
  };
};

/**
 * All of a thread but what a turn or a look at it changes, and the `revision` every write does, for
 * subscribers reading none of them.
 */
export const besidesActivity = ({
  lastActivityAt: _at,
  unread: _unread,
  revision: _revision,
  ...rest
}: Thread) => JSON.stringify(rest);
