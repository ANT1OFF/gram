/**
 * Node has no openat/renameat API. This fixed, isolated helper supplies those operations without
 * giving a Dream an interpreter or command surface. Every component below the configured data
 * root is opened with O_DIRECTORY|O_NOFOLLOW; all subsequent operations use those directory fds.
 * No PATH lookup, inherited environment, site modules, project code or shell is involved.
 * Missing /usr/bin/python3 or missing POSIX dir-fd support is an explicit refusal, never a fallback.
 */
import { InvalidState, NotFound } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type AnchoredOperation =
  | "probe"
  | "resolve"
  | "mkdir"
  | "read"
  | "fingerprint"
  | "list"
  | "write"
  | "unlink"
  | "rmtree";
export interface AnchoredRequest {
  readonly op: AnchoredOperation;
  readonly workspaceId: string;
  readonly rel: string;
  readonly within: string;
  readonly content?: string;
  readonly mode?: number;
  readonly maxBytes?: number;
}
export type FileBoundary = "anchored" | "opened" | "chunk" | "staged" | "committing";
export interface AnchoredOptions {
  /** Trusted caller coordination, never part of a model's tool arguments. */
  readonly boundary?: (phase: FileBoundary) => Effect.Effect<void, { readonly message: string }>;
  /** Authorize the final operation while holding the binding/store lock, through its completion. */
  readonly commit?: <A>(
    effect: Effect.Effect<A, InvalidState | NotFound>,
  ) => Effect.Effect<A, InvalidState | NotFound>;
}

// Kept inline so the existing server/desktop bundlers carry the exact helper with the code.
// The protocol permits only these fixed file operations. It never evals or executes request text.
export const ANCHORED_FILE_PROGRAM = String.raw`
import os, sys, json, stat, uuid, hashlib

MAX = 4 * 1024 * 1024
def send(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)
def boundary(phase):
    send({"phase": phase})
    if sys.stdin.readline(32) != "continue\n":
        raise ValueError("File operation revoked")
def plain(s):
    if not isinstance(s, str) or not s or s in (".", "..") or "/" in s or "\\" in s or "\x00" in s:
        raise ValueError("Invalid confined path")
    return s
def parts(s):
    return [] if s == "" else [plain(p) for p in s.split("/")]
def regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Not a singly linked regular file")
    return info
def info(fd):
    s = os.fstat(fd)
    if stat.S_ISREG(s.st_mode):
        regular(fd)
        kind = "file"
    elif stat.S_ISDIR(s.st_mode):
        kind = "dir"
    else:
        raise ValueError("Not a regular file or directory")
    return {"kind": kind, "stats": {"size": s.st_size, "mtimeMs": s.st_mtime * 1000,
        "birthtimeMs": getattr(s, "st_birthtime", 0) * 1000}}
def run(q):
    needed = (os.open, os.mkdir, os.stat, os.rename, os.unlink, os.rmdir)
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY") or any(f not in os.supports_dir_fd for f in needed) or os.scandir not in os.supports_fd:
        raise ValueError("Anchored file operations unavailable on this platform")
    op = q["op"]
    if op == "probe":
        return True
    if op not in ("resolve", "mkdir", "read", "fingerprint", "list", "write", "unlink", "rmtree"):
        raise ValueError("Unknown file operation")
    names = [plain(q["workspaceId"])] + parts(q["rel"])
    bound = [names[0]] + parts(q["within"])
    if names[:len(bound)] != bound or len(names) > 32:
        raise ValueError("Path outside confined tree")
    if op == "rmtree" and (q["rel"] == "" or q["rel"] == q["within"]):
        raise ValueError("Refusing to remove a whole tree")
    limit = q.get("maxBytes", MAX)
    if not isinstance(limit, int) or limit < 0 or limit > MAX:
        raise ValueError("Invalid read cap")
    create = op in ("mkdir", "write")
    if create:
        os.makedirs(q["root"], mode=0o700, exist_ok=True)
    dirs = []
    temp = None
    tempfd = None
    parent = None
    try:
        # Parents ABOVE this configured root are trusted (e.g. macOS /tmp). Below it no pathname
        # traversal is used: even moving an opened ancestor preserves the original capability.
        fd = os.open(q["root"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        dirs.append(fd)
        for name in names[:-1]:
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    return {"kind": "missing"} if op == "resolve" else None if op in ("list", "unlink", "rmtree") else missing()
                try:
                    os.mkdir(name, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            dirs.append(child)
            fd = child
        parent = fd
        name = names[-1]
        boundary("anchored")
        if op == "mkdir":
            try:
                os.mkdir(name, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(child)
            return None
        if op == "write":
            data = q["content"].encode("utf-8")
            if len(data) > MAX:
                raise ValueError("Write exceeds helper cap")
            try:
                target = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(target.st_mode) or target.st_nlink != 1:
                    raise ValueError("Target is not a singly linked regular file")
            except FileNotFoundError:
                pass
            temp = ".tmp-" + str(uuid.uuid4())
            tempfd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, q.get("mode", 0o600), dir_fd=parent)
            pos = 0
            while pos < len(data):
                pos += os.write(tempfd, data[pos:])
            boundary("staged")
            regular(tempfd)
            boundary("committing")
            os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
            temp = None
            return None
        if op == "rmtree":
            remove(parent, name)
            return None
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if op == "list":
            flags |= os.O_DIRECTORY
        try:
            child = os.open(name, flags, dir_fd=parent)
        except FileNotFoundError:
            return {"kind": "missing"} if op == "resolve" else None if op in ("list", "unlink") else missing()
        try:
            if op == "resolve":
                return info(child)
            if op == "list":
                entries = []
                with os.scandir(child) as it:
                    for entry in it:
                        if len(entries) >= 2048:
                            raise ValueError("Too many directory entries")
                        s = entry.stat(follow_symlinks=False)
                        kind = "dir" if stat.S_ISDIR(s.st_mode) else "file" if stat.S_ISREG(s.st_mode) and s.st_nlink == 1 else "other"
                        entries.append({"name": entry.name, "kind": kind})
                return sorted(entries, key=lambda e: e["name"])
            s = regular(child)
            if op == "unlink":
                os.unlink(name, dir_fd=parent)
                return None
            if s.st_size > limit:
                raise ValueError("File exceeds read cap")
            boundary("opened")
            data = bytearray()
            while len(data) <= limit:
                chunk = os.read(child, min(65536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                # This handshake bounds output and also permits deterministic growth/race tests
                # at a real opened handle, with no test code or model instructions in the helper.
                boundary("chunk")
            if len(data) > limit or regular(child).st_size > limit:
                raise ValueError("File exceeds read cap")
            if op == "fingerprint":
                return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            return data.decode("utf-8", errors="replace")
        finally:
            os.close(child)
    except FileNotFoundError:
        return {"kind": "missing"} if op == "resolve" else None if op in ("list", "unlink", "rmtree") else missing()
    finally:
        if tempfd is not None:
            os.close(tempfd)
        if temp is not None:
            try:
                os.unlink(temp, dir_fd=parent)
            except FileNotFoundError:
                pass
        for fd in reversed(dirs):
            os.close(fd)
def missing():
    raise FileNotFoundError("Confined file missing")
def remove(parent, name):
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        with os.scandir(child) as it:
            for entry in it:
                if entry.is_dir(follow_symlinks=False):
                    remove(child, entry.name)
                else:
                    os.unlink(entry.name, dir_fd=child)
    finally:
        os.close(child)
    os.rmdir(name, dir_fd=parent)
try:
    raw = sys.stdin.buffer.readline(8 * MAX + 1)
    if len(raw) > 8 * MAX:
        raise ValueError("Request exceeds helper cap")
    result = run(json.loads(raw))
    send({"result": result})
except Exception as e:
    send({"error": "missing" if isinstance(e, FileNotFoundError) else "refused",
        "message": str(e)[:300]})
`;

/** One short-lived process per operation; interruption/denial closes stdin so staged writes clean up. */
export const anchoredRequest = <A>(
  root: string,
  request: AnchoredRequest,
  options: AnchoredOptions = {},
): Effect.Effect<A, InvalidState | NotFound> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform !== "darwin" && process.platform !== "linux")
        return yield* new InvalidState({
          message:
            "Dream's anchored file operations require macOS/Linux and /usr/bin/python3; unavailable on this platform",
        });
      const child = spawn("/usr/bin/python3", ["-I", "-S", "-u", "-c", ANCHORED_FILE_PROGRAM], {
        cwd: "/",
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 20_000,
        killSignal: "SIGKILL",
      });
      // Deliberately discard stderr: neither Python startup nor OS errors may log private data.
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      const iterator = lines[Symbol.asyncIterator]();
      let spawnError = false;
      child.once("error", () => {
        spawnError = true;
        lines.close();
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.stdin.on("error", () => undefined);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          child.stdin.end();
          // A cooperative EOF lets the fixed helper unlink its own staged temp before exit.
          const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
          await closed;
          clearTimeout(timer);
          lines.close();
        }),
      );
      const raw = JSON.stringify({ ...request, root }) + "\n";
      if (Buffer.byteLength(raw) > 32 * 1024 * 1024)
        return yield* new InvalidState({ message: "File request exceeds helper cap" });
      child.stdin.write(raw);
      const receive = (): Effect.Effect<A, InvalidState | NotFound> =>
        Effect.gen(function* () {
          const next = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new InvalidState({ message: "Anchored file helper failed" }),
          });
          if (next.done)
            return yield* new InvalidState({
              message: spawnError
                ? "Dream's anchored file helper requires /usr/bin/python3 with POSIX directory-handle support"
                : "Anchored file helper ended without a result",
            });
          const response = yield* Effect.try({
            try: () =>
              JSON.parse(next.value) as {
                phase?: FileBoundary;
                error?: string;
                message?: string;
                result?: A;
              },
            catch: () => new InvalidState({ message: "Invalid anchored file helper response" }),
          });
          if (response.error === "missing")
            return yield* new NotFound({
              entity: "file",
              id: request.rel,
              message: `No confined file ${request.rel}`,
            });
          if (response.error)
            return yield* new InvalidState({
              message: `Confined file operation refused: ${response.message ?? "unavailable"}`,
            });
          if (response.phase) {
            if (options.boundary)
              yield* options
                .boundary(response.phase)
                .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
            const advance = Effect.sync(() => child.stdin.write("continue\n")).pipe(
              Effect.andThen(receive),
            );
            // Reads/deletes/mkdir/list start only while authorized; writes stage first then take the
            // same guard for the rename. Keep it held until the helper returns, not just the check.
            const final =
              request.op === "write" ? response.phase === "staged" : response.phase === "anchored";
            return yield* final && options.commit ? options.commit(advance) : advance;
          }
          return response.result as A;
        });
      return yield* receive();
    }),
  );
