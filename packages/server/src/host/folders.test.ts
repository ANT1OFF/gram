import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import {
  HOST_PROTOCOL_VERSION,
  HostId,
  HostUnavailable,
  LOCAL_HOST_ID,
  type HostCapability,
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
import { type FolderBounds, folderRefusal, foldersOn } from "./folders.ts";
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
 * A synthetic home: plain folders, a repository, credential folders, the host's own folder, a link
 * into `.ssh` and a file. Nothing in it is a real key or a real host's.
 */
const home = (dir: string): FolderBounds => {
  const at = join(dir, "home");
  for (const folder of [
    "Downloads",
    "scratch",
    ".ssh",
    ".aws",
    ".config/gram-host/repos/widgets",
    ".config/nvim",
  ])
    mkdirSync(join(at, folder), { recursive: true });
  writeFileSync(join(at, ".ssh", "id_ed25519"), "not a key\n");
  writeFileSync(join(at, "notes.md"), "notes\n");
  symlinkSync(join(at, ".ssh"), join(at, "keys"));
  if (hasGit) makeRepo(join(at, "code"));
  return { home: at, hostHome: join(at, ".config", "gram-host") };
};

const names = (listing: { readonly entries: ReadonlyArray<{ readonly name: string }> }) =>
  listing.entries.map((entry) => entry.name);

describe("folderRefusal", () => {
  const bounds = { home: "/home/dev", hostHome: "/home/dev/.config/gram-host" };
  it("refuses credential folders, the host's own folder and the whole filesystem", () => {
    expect(folderRefusal("/home/dev/.ssh", bounds)).toBe(
      "Gram doesn't run a chat in /home/dev/.ssh: it holds keys or credentials.",
    );
    expect(folderRefusal("/home/dev/.aws/sso", bounds)).toContain("keys or credentials");
    expect(folderRefusal("/home/dev/.config/gh", bounds)).toContain("keys or credentials");
    expect(folderRefusal("/home/dev/.config/gram-host/repos/x", bounds)).toBe(
      "Gram doesn't run a chat in /home/dev/.config/gram-host/repos/x: it is Gram Host's own folder.",
    );
    expect(folderRefusal("/", bounds)).toBe("Gram doesn't run a chat in the whole filesystem.");
  });

  it("takes a home, a project and a dotfolder that holds no credentials", () => {
    for (const path of ["/home/dev", "/home/dev/code/api", "/home/dev/.config/nvim", "/srv/media"])
      expect(folderRefusal(path, bounds), path).toBeUndefined();
  });
});

describe("a machine's folders, on the machine", () => {
  it.live("lists folders from its own home, hiding credential folders and its own", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const bounds = home(dir);
      const folders = foldersOn(yield* Proc, bounds);

      const top = yield* folders.browse("~/", 100);
      expect(top.path).toBe(bounds.home);
      // Dotfolders only for a `.` prefix, as `fs.browse` lists them; files never.
      expect(names(top)).toEqual([...(hasGit ? ["code"] : []), "Downloads", "scratch"]);
      expect(names(yield* folders.browse("~/.c", 100))).toEqual([".config"]);
      expect(names(yield* folders.browse("~/.config/", 100))).toEqual(["nvim"]);

      // Never listed into, typed or through a link.
      for (const input of ["~/.ssh/", "~/.config/gram-host/", "~/keys/"]) {
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

      expect(yield* folders.check("~")).toEqual({ path: bounds.home });
      expect(yield* folders.check(`${bounds.home}/scratch/`)).toEqual({
        path: join(bounds.home, "scratch"),
      });
      if (hasGit)
        expect(yield* folders.check("~/code/repo")).toEqual({
          path: join(bounds.home, "code", "repo"),
          branch: "main",
        });

      const why = (path: string) =>
        folders.check(path).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      expect(yield* why("~/.ssh")).toBe(
        `Gram doesn't run a chat in ${join(bounds.home, ".ssh")}: it holds keys or credentials.`,
      );
      // A link is judged where it leads.
      expect(yield* why("~/keys")).toBe(
        `Gram doesn't run a chat in ${join(bounds.home, ".ssh")}: it holds keys or credentials.`,
      );
      expect(yield* why("~/.config/gram-host/repos/widgets")).toContain("Gram Host's own folder");
      expect(yield* why("/")).toBe("Gram doesn't run a chat in the whole filesystem.");
      expect(yield* why("~/notes.md")).toBe(`Not a folder: ${join(bounds.home, "notes.md")}`);
      expect(yield* why("~/missing")).toBe(`Folder not found: ${join(bounds.home, "missing")}`);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
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

      const refused = yield* placed
        .prepare({ kind: "machineFolder", hostId: MACHINE.id, path: "~/keys" }, [], "")
        .pipe(Effect.flip);
      expect(refused._tag).toBe("InvalidState");
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
