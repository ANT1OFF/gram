import { FS_RESOLVE_LIMIT, type FsResolveResult, type ThreadId } from "@gram/contracts";

/** What a path is known to be: the file it names, or `null` when it names none. */
type FileRefEntry = { readonly resolved: string } | null;

export interface FileRefResolver {
  /** The known answer for `path` in `threadId`, or `undefined` until it has been asked. */
  get(threadId: ThreadId, path: string): FileRefEntry | undefined;
  /** Asks about `path` with every other path requested in the same moment, in one call. */
  request(threadId: ThreadId, path: string): void;
  /**
   * Asks about every known path again, and those still being asked about: the files may have
   * changed, or the checkouts they are in. An answer to a call made before is dropped. A path that
   * named no file is forgotten meanwhile; one that named a file keeps its answer until then.
   */
  refresh(threadId: ThreadId): void;
  subscribe(listener: () => void): () => void;
}

/** `map`'s value for `threadId`, made first when it has none. */
const bucket = <V>(map: Map<ThreadId, V>, threadId: ThreadId, make: () => V): V => {
  let value = map.get(threadId);
  if (value === undefined) map.set(threadId, (value = make()));
  return value;
};

/**
 * Answers which paths are files, batched and cached per thread: the transcript's references all
 * render in the same moment, so they go out as one `fs.resolve` call (per `FS_RESOLVE_LIMIT` paths)
 * after `delayMs`, and a path is asked about once.
 */
export function createFileRefResolver(
  resolve: (threadId: ThreadId, paths: readonly string[]) => Promise<FsResolveResult>,
  delayMs = 50,
): FileRefResolver {
  const known = new Map<ThreadId, Map<string, FileRefEntry>>();
  const pending = new Map<ThreadId, Set<string>>();
  const asked = new Map<ThreadId, Set<string>>();
  /** Bumped by `refresh`: an answer asked for before it may be about checkouts the thread left. */
  const generations = new Map<ThreadId, number>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const send = (threadId: ThreadId, paths: string[]) => {
    const inFlight = bucket(asked, threadId, () => new Set<string>());
    for (const path of paths) inFlight.add(path);
    const generation = generations.get(threadId) ?? 0;
    const settle = (files: FsResolveResult["files"]) => {
      // Stale: `refresh` has queued these paths again, and that call's answer is the one to keep.
      if ((generations.get(threadId) ?? 0) !== generation) return;
      const answers = bucket(known, threadId, () => new Map<string, FileRefEntry>());
      const found = new Map(files.map((file) => [file.path, file.resolved]));
      for (const path of paths) {
        inFlight.delete(path);
        const resolved = found.get(path);
        answers.set(path, resolved === undefined ? null : { resolved });
      }
      notify();
    };
    resolve(threadId, paths).then(
      (result) => settle(result.files),
      (error: unknown) => {
        // An older server without `fs.resolve`, or a thread gone: its paths stay plain text.
        console.warn("file refs", error);
        settle([]);
      },
    );
  };

  const flush = () => {
    timer = undefined;
    const batches = [...pending];
    pending.clear();
    for (const [threadId, paths] of batches) {
      const all = [...paths];
      for (let i = 0; i < all.length; i += FS_RESOLVE_LIMIT) {
        send(threadId, all.slice(i, i + FS_RESOLVE_LIMIT));
      }
    }
  };

  return {
    get: (threadId, path) => known.get(threadId)?.get(path),
    request: (threadId, path) => {
      if (known.get(threadId)?.has(path) || asked.get(threadId)?.has(path)) return;
      bucket(pending, threadId, () => new Set<string>()).add(path);
      timer ??= setTimeout(flush, delayMs);
    },
    refresh: (threadId) => {
      generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
      const again = new Set(asked.get(threadId));
      let dropped = false;
      for (const [path, entry] of known.get(threadId) ?? []) {
        if (entry === null) {
          known.get(threadId)!.delete(path);
          dropped = true;
        } else {
          // Kept until the new answer comes, so a link doesn't blink; it may have moved, or a second
          // file of its name may have appeared since.
          again.add(path);
        }
      }
      if (again.size > 0) {
        const queued = bucket(pending, threadId, () => new Set<string>());
        for (const path of again) queued.add(path);
        timer ??= setTimeout(flush, delayMs);
      }
      if (dropped) notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
