import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { HOST_PROTOCOL_VERSION, type HostBusy, LOCAL_HOST_ID } from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { createConnection } from "node:net";
import { ensureLocalSecret } from "./local-handshake.ts";
import { connectLocalService } from "./local-service-unit.ts";
import { serveLocal } from "./local-service.ts";
import { HOST_CAPABILITIES, HOST_FEATURES, type HostService } from "./protocol.ts";
import { reposOn } from "./repos.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";

/** A host with no agents: enough to be served and connected to. */
const host = Effect.gen(function* () {
  const proc = yield* Proc;
  return {
    hello: {
      protocol: HOST_PROTOCOL_VERSION,
      hostId: LOCAL_HOST_ID,
      capabilities: HOST_CAPABILITIES,
      features: HOST_FEATURES,
      platform: process.platform,
      pid: process.pid,
    },
    files: filesOn(proc),
    reads: fileReadsOn(proc),
    attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-local-attached-"))),
    repos: reposOn(proc, "/nonexistent/gram-local-repos"),
    worktrees: yield* Worktrees,
    git: gitOn(proc),
    terminals: yield* terminalsOnHost,
    sessions: yield* sessionsOnHost(() => Effect.die(new Error("no agents here"))),
    scan: Effect.succeed({ listening: new Map(), children: new Map() }),
  } as unknown as HostService;
});

const folder = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-local-service-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

const idle: HostBusy = { turns: 0, terminals: 0, clones: 0, checks: 0 };

const eventually = <E, R>(label: string, check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if (yield* check) return;
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const env = WorktreesLive.pipe(Layer.provideMerge(ProcLive));

describe.skipIf(process.platform === "win32")(
  "this machine's host kept running after Gram quits",
  () => {
    it.live("serves one app on a socket only this user can reach, and is the only host on it", () =>
      Effect.gen(function* () {
        const dir = yield* folder;
        const socket = join(dir, "local-host", "host.sock");
        const secretFile = join(dir, "local-host", "secret");
        const secret = ensureLocalSecret(secretFile);
        yield* serveLocal(socket, host, { busy: Effect.succeed(idle), secretFile }).pipe(
          Effect.forkScoped,
        );
        const connection = yield* Effect.scoped(connectLocalService(socket, secret, 5_000));
        expect(connection.hello.hostId).toBe(LOCAL_HOST_ID);
        expect(statSync(join(dir, "local-host")).mode & 0o777).toBe(0o700);
        expect(statSync(socket).mode & 0o777).toBe(0o600);
        // A second host for the same socket stops rather than take it over.
        const second = yield* serveLocal(socket, host, {
          busy: Effect.succeed(idle),
          secretFile,
        }).pipe(Effect.scoped, Effect.exit);
        expect(Exit.isFailure(second)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(env)),
    );

    it.live("lets an older app go when a newer one connects", () =>
      Effect.gen(function* () {
        const dir = yield* folder;
        const socket = join(dir, "local-host", "host.sock");
        const secretFile = join(dir, "local-host", "secret");
        const secret = ensureLocalSecret(secretFile);
        yield* serveLocal(socket, host, { busy: Effect.succeed(idle), secretFile }).pipe(
          Effect.forkScoped,
        );
        const older = yield* connectLocalService(socket, secret, 5_000);
        const newer = yield* connectLocalService(socket, secret, 5_000);
        yield* eventually(
          "the older app let go",
          Effect.sync(() => older.gone()),
        );
        expect(newer.gone()).toBe(false);
        expect(yield* newer.terminals.list(undefined)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(env)),
    );

    it.live("ends on its own once no app is connected and nothing runs, and not before", () =>
      Effect.gen(function* () {
        const dir = yield* folder;
        const socket = join(dir, "local-host", "host.sock");
        const secretFile = join(dir, "local-host", "secret");
        const secret = ensureLocalSecret(secretFile);
        let busy: HostBusy = { ...idle, turns: 1 };
        const serving = yield* serveLocal(socket, host, {
          busy: Effect.sync(() => busy),
          secretFile,
          idleExitMs: 100,
          idleCheckMs: 20,
        }).pipe(Effect.scoped, Effect.forkScoped);
        // An app comes and goes; a turn still runs, so the host stays.
        yield* Effect.scoped(connectLocalService(socket, secret, 5_000));
        yield* Effect.sleep("400 millis");
        expect(serving.pollUnsafe()).toBeUndefined();
        // Its turn ends: the host ends within the idle wait, and takes its socket with it.
        busy = idle;
        yield* Fiber.join(serving).pipe(Effect.timeout("5 seconds"));
        expect(() => statSync(socket)).toThrow();
      }).pipe(Effect.scoped, Effect.provide(env)),
    );

    it.live(
      "serves no one who can't prove the install's secret, and they never displace the app",
      () =>
        Effect.gen(function* () {
          const dir = yield* folder;
          const socket = join(dir, "local-host", "host.sock");
          const secretFile = join(dir, "local-host", "secret");
          const secret = ensureLocalSecret(secretFile);
          expect(statSync(secretFile).mode & 0o777).toBe(0o600);
          yield* serveLocal(socket, host, { busy: Effect.succeed(idle), secretFile }).pipe(
            Effect.forkScoped,
          );
          const app = yield* connectLocalService(socket, secret, 5_000);
          // Another process of the same user, as the review's reproduction: it connects and speaks
          // the host protocol straight away (a hello, then an answer to an approval).
          const intruder = yield* Effect.promise(
            () =>
              new Promise<{ closed: boolean; heard: string }>((resolve) => {
                const raw = createConnection(socket);
                let heard = "";
                raw.on("data", (chunk) => {
                  heard += chunk.toString();
                  raw.write(
                    '{"_tag":"Request","id":"1","tag":"host.hello","payload":{},"headers":[]}\n',
                  );
                });
                raw.on("close", () => resolve({ closed: true, heard }));
                raw.on("error", () => {});
              }),
          );
          expect(intruder.closed).toBe(true);
          // It was asked to prove itself, and never answered as the host.
          expect(intruder.heard).toContain('"gramLocalHost":1');
          expect(intruder.heard).not.toContain("host.hello");
          expect(intruder.heard).not.toContain('"proof"');
          // A process holding a wrong secret is refused the same way.
          const wrong = yield* connectLocalService(socket, "0".repeat(64), 2_000).pipe(
            Effect.scoped,
            Effect.exit,
          );
          expect(Exit.isFailure(wrong)).toBe(true);
          // The app is still the one served.
          expect(app.gone()).toBe(false);
          expect(yield* app.terminals.list(undefined)).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(env)),
    );

    it.live("the app refuses a socket that can't prove it is this install's host", () =>
      Effect.gen(function* () {
        const dir = yield* folder;
        const socket = join(dir, "local-host", "host.sock");
        const secretFile = join(dir, "local-host", "secret");
        const secret = ensureLocalSecret(secretFile);
        // A host started with another install's secret stands in for one squatting the socket.
        const otherFile = join(dir, "other-secret");
        ensureLocalSecret(otherFile);
        yield* serveLocal(socket, host, { busy: Effect.succeed(idle), secretFile: otherFile }).pipe(
          Effect.forkScoped,
        );
        const refused = yield* connectLocalService(socket, secret, 2_000).pipe(
          Effect.scoped,
          Effect.exit,
        );
        expect(Exit.isFailure(refused)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(env)),
    );
  },
);
