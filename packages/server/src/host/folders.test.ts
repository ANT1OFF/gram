import {
  chmodSync,
  mkdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import type { AgentHost, AgentSession, OpenSessionOptions } from "@gram/agents";
import {
  HOST_PROTOCOL_VERSION,
  HostId,
  HostUnavailable,
  LOCAL_HOST_ID,
  type HostCapability,
  ThreadId,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { EventHub } from "../events/event-hub.ts";
import { hasGit, makeRepo, removeDir, tempDir } from "../git/test-repo.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import {
  type FolderBounds,
  type FolderIo,
  foldersOn,
  gatedSessions,
  MAX_LISTED,
  MAX_SCANNED,
} from "./folders.ts";
import { gitOn } from "./git.ts";
import { connectHost, HOST_CAPABILITIES, HOST_SERVES, serveHost } from "./protocol.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import { machineHosts } from "./remote-worker-host.ts";
import { reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";
import { WorkerHosts } from "./worker-host.ts";

const MACHINE = { id: HostId.make("m-0123456789abcdef01234567"), name: "build box" };

/**
 * A synthetic home: plain folders, a repository, credential and agent login folders (with no real
 * key or login in them), the host's own folder with a worktree of a clone, a link into `.ssh` and a
 * file. Nothing in it is a real key or a real host's.
 */
const home = (dir: string): FolderBounds => {
  const at = join(dir, "home");
  for (const folder of [
    "Downloads",
    "scratch",
    ".ssh",
    ".aws",
    ".claude/synthetic",
    ".codex/synthetic",
    ".config/gram-host/repos/widgets/.worktrees/feat-x",
    ".config/nvim",
  ])
    mkdirSync(join(at, folder), { recursive: true });
  writeFileSync(join(at, ".ssh", "id_ed25519"), "not a key\n");
  writeFileSync(join(at, "notes.md"), "notes\n");
  symlinkSync(join(at, ".ssh"), join(at, "keys"));
  if (hasGit) makeRepo(join(at, "code"));
  return {
    home: at,
    hostHome: join(at, ".config", "gram-host"),
    hostRepos: join(at, ".config", "gram-host", "repos"),
    agentHomes: [],
  };
};

const names = (listing: { readonly entries: ReadonlyArray<{ readonly name: string }> }) =>
  listing.entries.map((entry) => entry.name);

/** Why the gate refused `path`, or "admitted". */
const verdict = (folders: ReturnType<typeof foldersOn>, path: string) =>
  folders
    .check(path)
    .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "admitted" }));

const keys = (path: string) => `Gram doesn't run a chat in ${path}: it holds keys or credentials.`;
const own = (path: string) => `Gram doesn't run a chat in ${path}: it is Gram Host's own folder.`;

describe("a machine's folders, on the machine", () => {
  it.live("lists folders from its own home, hiding credential, login and its own folders", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const folders = foldersOn(yield* Proc, bounds);

      const top = yield* folders.browse("~/", 100);
      expect(top.path).toBe(bounds.home);
      // Dotfolders only for a `.` prefix, as `fs.browse` lists them; files and links never.
      expect(names(top)).toEqual([...(hasGit ? ["code"] : []), "Downloads", "scratch"]);
      expect(names(yield* folders.browse("~/.", 100))).toEqual([".config"]);
      expect(names(yield* folders.browse("~/.config/", 100))).toEqual(["nvim"]);

      // Never listed into, typed, through a link, or as an agent's login folder.
      for (const input of [
        "~/.ssh/",
        "~/.config/gram-host/",
        "~/keys/",
        "~/.claude/",
        "~/.codex/",
      ]) {
        const refused = yield* folders.browse(input, 100).pipe(Effect.flip);
        expect(refused._tag, input).toBe("InvalidState");
      }
      expect((yield* folders.browse("~/nope/", 100).pipe(Effect.flip))._tag).toBe("NotFound");
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("checks a folder to run in: its real path and branch, or why not", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const folders = foldersOn(yield* Proc, bounds);
      const at = (path: string) => join(bounds.home, path);

      expect(yield* folders.check("~")).toEqual({ path: bounds.home });
      expect(yield* folders.check(`${bounds.home}/scratch/`)).toEqual({ path: at("scratch") });
      if (hasGit)
        expect(yield* folders.check("~/code/repo")).toEqual({
          path: join(bounds.home, "code", "repo"),
          branch: "main",
        });

      expect(yield* verdict(folders, "~/.ssh")).toBe(keys(at(".ssh")));
      // A link is judged where it leads.
      expect(yield* verdict(folders, "~/keys")).toBe(keys(at(".ssh")));
      // The agents' login folders, and anything in them (review #348, finding 1).
      expect(yield* verdict(folders, "~/.claude")).toBe(keys(at(".claude")));
      expect(yield* verdict(folders, "~/.codex/synthetic")).toBe(keys(at(".codex/synthetic")));
      expect(yield* verdict(folders, "~/.config/gram-host")).toBe(own(at(".config/gram-host")));
      // A worker's worktree in the host's clones is no place for a one-off chat.
      expect(yield* verdict(folders, "~/.config/gram-host/repos/widgets/.worktrees/feat-x")).toBe(
        own(at(".config/gram-host/repos/widgets/.worktrees/feat-x")),
      );
      expect(yield* verdict(folders, "/")).toBe("Gram doesn't run a chat in the whole filesystem.");
      expect(yield* verdict(folders, "~/notes.md")).toBe(`Not a folder: ${at("notes.md")}`);
      expect(yield* verdict(folders, "~/missing")).toBe(`Folder not found: ${at("missing")}`);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("refuses an agent's login folder where it is configured to be", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const configured = join(dir, "claude-config");
      mkdirSync(join(configured, "projects"), { recursive: true });
      const folders = foldersOn(yield* Proc, { ...home(dir), agentHomes: [configured] });
      expect(yield* verdict(folders, configured)).toBe(keys(configured));
      expect(yield* verdict(folders, join(configured, "projects"))).toBe(
        keys(join(configured, "projects")),
      );
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});

/**
 * Review #348, finding 2: a protected folder is the folder itself, not its spelling. Each case
 * configures the bound one way and asks for the folder another.
 */
describe("the gate compares folders, not spellings", () => {
  it.live("refuses the host's folder named through a link in the configured bound", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const real = join(dir, "real-home");
      mkdirSync(join(real, ".config", "gram-host", "keys-here"), { recursive: true });
      symlinkSync(real, join(dir, "alias"));
      const folders = foldersOn(yield* Proc, {
        home: real,
        hostHome: join(dir, "alias", ".config", "gram-host"),
        hostRepos: join(dir, "alias", ".config", "gram-host", "repos"),
        agentHomes: [],
      });
      const target = join(real, ".config", "gram-host");
      expect(yield* verdict(folders, target)).toBe(own(target));
      expect(yield* verdict(folders, join(target, "keys-here"))).toBe(
        own(join(target, "keys-here")),
      );
      const browse = yield* folders.browse(`${target}/`, 10).pipe(Effect.flip);
      expect(browse.message).toBe(own(target));
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("refuses the host's folder in another case, where the filesystem ignores case", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const real = join(dir, "real-home");
      mkdirSync(join(real, ".config", "gram-host"), { recursive: true });
      const upper = join(real, ".CONFIG", "GRAM-HOST");
      const foldsCase = yield* Effect.promise(() =>
        fsp.stat(upper).then(
          () => true,
          () => false,
        ),
      );
      if (!foldsCase) return; // A case-sensitive filesystem: two spellings are two folders.
      const folders = foldersOn(yield* Proc, {
        home: real,
        hostHome: upper,
        hostRepos: join(upper, "repos"),
        agentHomes: [],
      });
      const lower = join(real, ".config", "gram-host");
      expect(yield* verdict(folders, lower)).toBe(own(lower));
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live(
    "refuses the host's folder in another Unicode form, where the filesystem joins them",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
        const nfc = join(dir, "caf\u00e9-host");
        const nfd = join(dir, "cafe\u0301-host");
        mkdirSync(nfc);
        const joinsForms = yield* Effect.promise(() =>
          fsp.stat(nfd).then(
            () => true,
            () => false,
          ),
        );
        if (!joinsForms) return; // The filesystem keeps the two forms apart: two folders.
        const folders = foldersOn(yield* Proc, {
          home: dir,
          hostHome: nfd,
          hostRepos: join(nfd, "repos"),
          agentHomes: [],
        });
        const answer = yield* verdict(folders, nfc);
        expect(answer).not.toBe("admitted");
        expect(answer).toContain("Gram Host's own folder");
      }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("refuses a credential folder moved elsewhere behind a link", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const store = join(dir, "synthetic-key-store");
      mkdirSync(join(store, "inner"), { recursive: true });
      const bounds = home(dir);
      renameSync(join(bounds.home, ".ssh"), join(dir, "old-ssh"));
      symlinkSync(store, join(bounds.home, ".ssh"));
      const folders = foldersOn(yield* Proc, bounds);
      expect(yield* verdict(folders, store)).toBe(keys(store));
      expect(yield* verdict(folders, join(store, "inner"))).toBe(keys(join(store, "inner")));
      expect((yield* folders.browse(`${store}/`, 10).pipe(Effect.flip))._tag).toBe("InvalidState");
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});

/**
 * Re-review of #348, findings 4 and 5: a protected folder that can't be read refuses, and one that
 * is two protected folders at once keeps the strictest protection.
 */
describe("the gate fails closed", () => {
  it.live("refuses when a protected folder's identity can't be read", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const parent = join(dir, "unsearchable-parent");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          chmodSync(parent, 0o700);
          removeDir(dir);
        }),
      );
      // A configured login folder behind a parent this user can't search, leading to a store that
      // is readable under another name.
      const store = join(dir, "synthetic-login-store");
      mkdirSync(store);
      mkdirSync(parent);
      symlinkSync(store, join(parent, "login"));
      chmodSync(parent, 0o000);
      const unreadable = yield* Effect.promise(() =>
        fsp.stat(join(parent, "login")).then(
          () => false,
          (error: { readonly code?: string }) => error.code === "EACCES" || error.code === "EPERM",
        ),
      );
      if (!unreadable) return; // Run as a user every folder is readable to: nothing to show.
      const folders = foldersOn(yield* Proc, {
        ...home(dir),
        agentHomes: [join(parent, "login")],
      });
      const answer = yield* verdict(folders, store);
      expect(answer).toBe(
        `Gram couldn't read ${join(parent, "login")} on this machine, so it can't tell whether this folder is one it keeps chats out of.`,
      );
      // Every use is refused while it can't be read, not only that folder.
      expect(yield* verdict(folders, "~/scratch")).toBe(answer);
      const agent = recordingAgent();
      const sessions = gatedSessions(
        yield* sessionsOnHost(() => Effect.succeed(agent.host)),
        folders.gate,
      );
      expect((yield* sessions.open(request(store)).pipe(Effect.flip)).message).toBe(answer);
      expect(agent.openedIn).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("keeps a credential folder's protection where it is also the host's clones", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      // An agent's login folder configured, through a link, as the very folder of the clones.
      symlinkSync(bounds.hostRepos, join(dir, "login-alias"));
      const folders = foldersOn(yield* Proc, { ...bounds, agentHomes: [join(dir, "login-alias")] });
      const agent = recordingAgent();
      const sessions = gatedSessions(
        yield* sessionsOnHost(() => Effect.succeed(agent.host)),
        folders.gate,
      );
      const worktree = join(bounds.hostRepos, "widgets", ".worktrees", "feat-x");
      const refused = yield* sessions.open(request(worktree)).pipe(Effect.flip);
      expect(refused.message).toBe(keys(worktree));
      expect(agent.openedIn).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});

/** A fake agent that records where each session really opened, and runs `during` as it opens. */
const recordingAgent = (during: () => void = () => {}) => {
  const openedIn: Array<string> = [];
  const host = {
    kind: "claude",
    open: (options: OpenSessionOptions) =>
      Effect.sync(() => {
        openedIn.push(realpathSync(options.cwd));
        during();
        return {
          events: Stream.never,
          send: () => Effect.void,
          steer: () => Effect.void,
          interrupt: Effect.void,
          respond: () => Effect.void,
          setMode: () => Effect.void,
          setModel: () => Effect.void,
        } as unknown as AgentSession;
      }),
  } as unknown as AgentHost;
  return { host, openedIn };
};

const request = (cwd: string, handle = "h-1") => ({
  handle,
  agent: "claude" as const,
  threadId: ThreadId.make("t-on-machine"),
  cwd,
});

/** A checked folder is checked again every time a session opens in it. */
describe("a joined machine's sessions", () => {
  it.live("never open in a folder swapped for a link to a refused one after its check", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const folders = foldersOn(yield* Proc, bounds);
      const scratch = join(bounds.home, "scratch");
      const { path: checked } = yield* folders.check("~/scratch");
      expect(checked).toBe(scratch);

      renameSync(scratch, join(bounds.home, "scratch-original"));
      symlinkSync(join(bounds.home, ".ssh"), scratch);
      const agent = recordingAgent();
      const sessions = gatedSessions(
        yield* sessionsOnHost(() => Effect.succeed(agent.host)),
        folders.gate,
      );
      const refused = yield* sessions.open(request(checked)).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "HostFailed",
        message: keys(join(bounds.home, ".ssh")),
      });
      expect(agent.openedIn).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("open in a worker's worktree of the host's clones, and in a picked folder", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const folders = foldersOn(yield* Proc, bounds);
      const agent = recordingAgent();
      const sessions = gatedSessions(
        yield* sessionsOnHost(() => Effect.succeed(agent.host)),
        folders.gate,
      );
      const worktree = join(bounds.hostRepos, "widgets", ".worktrees", "feat-x");
      yield* sessions.open(request(worktree, "h-worker"));
      yield* sessions.open(request(join(bounds.home, "scratch"), "h-chat"));
      expect(agent.openedIn).toEqual([worktree, join(bounds.home, "scratch")]);
      // The host's own folder outside its clones is still refused.
      const refused = yield* sessions.open(request(bounds.hostHome, "h-own")).pipe(Effect.flip);
      expect(refused.message).toBe(own(bounds.hostHome));
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});

/** Review #348, finding 4: a listing is bounded however large the folder or slow its disk. */
describe("a machine's folder listing", () => {
  it.live("lists at most MAX_LISTED folders, whatever limit it is asked for", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const many = join(bounds.home, "many");
      for (let i = 0; i < MAX_LISTED + 10; i++)
        mkdirSync(join(many, `d${String(i).padStart(4, "0")}`), { recursive: true });
      const listing = yield* foldersOn(yield* Proc, bounds).browse(`${many}/`, 1000);
      expect(listing.entries).toHaveLength(MAX_LISTED);
      expect(listing.truncated).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("reads at most MAX_SCANNED entries of a folder", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const huge = join(bounds.home, "huge");
      mkdirSync(huge);
      for (let i = 0; i < MAX_SCANNED + 20; i++) writeFileSync(join(huge, `f${i}`), "");
      let read = 0;
      const io: FolderIo = {
        realpath: (path) => fsp.realpath(path),
        stat: (path) => fsp.stat(path),
        opendir: async (path) => {
          const opened = await fsp.opendir(path);
          const entries = opened[Symbol.asyncIterator].bind(opened);
          return Object.assign(opened, {
            [Symbol.asyncIterator]: async function* () {
              for await (const entry of { [Symbol.asyncIterator]: entries }) {
                read += 1;
                yield entry;
              }
            },
          });
        },
      };
      const listing = yield* foldersOn(yield* Proc, bounds, io).browse(`${huge}/`, 10);
      expect(listing.truncated).toBe(true);
      expect(read).toBeLessThanOrEqual(MAX_SCANNED + 1);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("refuses a refused folder before reading anything in it", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const opened: Array<string> = [];
      const io: FolderIo = {
        realpath: (path) => fsp.realpath(path),
        stat: (path) => fsp.stat(path),
        opendir: (path) => {
          opened.push(path);
          return fsp.opendir(path);
        },
      };
      const folders = foldersOn(yield* Proc, bounds, io);
      for (const input of ["~/.ssh/", "~/keys/", "~/.config/gram-host/"])
        yield* folders.browse(input, 10).pipe(Effect.flip);
      expect(opened).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live(
    "doesn't wait on a folder whose disk doesn't answer",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
        const bounds = home(dir);
        // `scratch/.git` stands for a link into a mount that hangs: its probe never settles.
        const io: FolderIo = {
          realpath: (path) => fsp.realpath(path),
          stat: (path) =>
            path.endsWith(join("scratch", ".git")) ? new Promise(() => {}) : fsp.stat(path),
          opendir: (path) => fsp.opendir(path),
        };
        const started = Date.now();
        const listing = yield* foldersOn(yield* Proc, bounds, io).browse("~/", 50);
        expect(Date.now() - started).toBeLessThan(8_000);
        expect(listing.entries.find((entry) => entry.name === "scratch")?.isGitRepo).toBe(false);

        // A folder that never answers at all is given up on, not waited for.
        const stuck: FolderIo = { ...io, realpath: () => new Promise(() => {}) };
        const gaveUp = yield* foldersOn(yield* Proc, bounds, stuck)
          .browse("~/", 50)
          .pipe(Effect.flip);
        expect(gaveUp.message).toContain("took too long");
      }).pipe(Effect.scoped, Effect.provide(ProcLive)),
    20_000,
  );
});

/** The machine's host with `bounds` as its home, serving `capabilities`, and its connection. */
const machine = (bounds: FolderBounds, capabilities: ReadonlyArray<HostCapability>) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const proc = yield* Proc;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), {
          hello: {
            protocol: HOST_PROTOCOL_VERSION,
            hostId: MACHINE.id,
            capabilities,
            platform: "linux",
            pid: 7,
          },
          files: filesOn(proc),
          folders: foldersOn(proc, bounds),
          reads: fileReadsOn(proc),
          attachments: yield* attachmentsOnHost(join(bounds.home, "..", "attached")),
          repos: reposOn(proc, bounds.hostHome, {}),
          worktrees: yield* Worktrees,
          git: gitOn(proc),
          terminals: yield* terminalsOnHost,
          sessions: yield* sessionsOnHost(noAgents),
          scan: Effect.succeed({ listening: new Map(), children: new Map() }),
        });
      }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => host.destroy()))),
    );
    const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)), {
      hostId: MACHINE.id,
    });
    const remote = {
      connection: (id: HostId) =>
        id === MACHINE.id
          ? Effect.succeed(connection)
          : Effect.fail(new HostUnavailable({ hostId: id, message: "not joined" })),
      machines: { get: () => ({ name: MACHINE.name }) },
    } as unknown as RemoteHostsShape;
    const get = yield* machineHosts(remote, {
      store: { listThreads: Effect.succeed([]) } as unknown as ThreadStore["Service"],
      hub: { internalEvents: () => Stream.never } as unknown as EventHub["Service"],
      agents: AgentHosts.of({
        get: () => Effect.succeed({ kind: "claude" } as unknown as AgentHost),
      }),
      proc,
    });
    // Routed as the server routes it: a checkout request goes to the machine it names.
    const threads = {
      listThreads: Effect.succeed([]),
      getThread: () => Effect.die(new Error("no thread in this test")),
    } as unknown as ThreadStore["Service"];
    return WorkerHosts.fromHosts({ id: LOCAL_HOST_ID } as never, [], get, threads, () => true);
  });

const Live = WorktreesLive.pipe(Layer.provideMerge(ProcLive));

describe("a joined machine's folders, from the main Gram", () => {
  it.live("are listed and checked by that machine's host, never this disk", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const hosts = yield* machine(bounds, HOST_SERVES);
      const there = hosts.machine(MACHINE.id).folders;

      // `~` is the machine's home, as its host expands it.
      expect((yield* there.browse("~/", 50)).path).toBe(bounds.home);
      expect(yield* there.check("~/scratch")).toEqual({ path: join(bounds.home, "scratch") });
      const refused = yield* there.check("~/.ssh").pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "InvalidState",
        message: `Gram doesn't run a chat in ${join(bounds.home, ".ssh")}: it holds keys or credentials.`,
      });
      // This machine's folders are `fs.browse`'s own; none goes through here.
      const local = yield* hosts.machine(LOCAL_HOST_ID).folders.browse("~/", 5).pipe(Effect.flip);
      expect(local.message).toBe("That isn't a joined machine.");
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live("places a one-off thread in the folder the machine checked, recorded as its", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const hosts = yield* machine(bounds, HOST_SERVES);
      const placed = hosts.placed.checkouts;

      // The link is resolved there: the checkout is the folder it leads to.
      symlinkSync(join(bounds.home, "scratch"), join(bounds.home, "today"));
      const checkout = yield* placed.prepare(
        { kind: "machineFolder", hostId: MACHINE.id, path: "~/today" },
        [],
        "gram-host:unused",
      );
      expect(checkout).toEqual({
        kind: "main",
        path: join(bounds.home, "scratch"),
        hostId: MACHINE.id,
      });

      for (const path of ["~/keys", "~/.claude", "~/.codex/sessions"]) {
        const refused = yield* placed
          .prepare({ kind: "machineFolder", hostId: MACHINE.id, path }, [], "")
          .pipe(Effect.flip);
        expect(refused._tag, path).toBe("InvalidState");
      }
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live("asks for an update on a machine whose host doesn't list its folders", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const hosts = yield* machine(home(dir), HOST_CAPABILITIES);
      const older =
        "gram-host on build box is older than this Gram; update it (Settings → Machines, or rerun its install command there).";
      const browse = yield* hosts.machine(MACHINE.id).folders.browse("~/", 5).pipe(Effect.flip);
      expect(browse.message).toBe(older);
      const prepare = yield* hosts.placed.checkouts
        .prepare({ kind: "machineFolder", hostId: MACHINE.id, path: "~" }, [], "")
        .pipe(Effect.flip);
      expect(prepare.message).toBe(older);
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );
});
