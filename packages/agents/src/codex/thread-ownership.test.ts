import { describe, expect, it } from "@effect/vitest";
import { ProfileId, ThreadId, type AgentUnavailable } from "@gram/contracts";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Redacted from "effect/Redacted";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import type { AgentSession } from "../host.ts";
import { GatewayKeyProvider } from "../gateway.ts";
import { CodexHost, CodexHostLayer } from "./session.ts";
import { CodexServers, CodexServersLive, type CodexServer } from "./servers.ts";

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-thread-owner-")));
  const binary = join(root, "codex"),
    shell = join(root, "shell");
  writeFileSync(
    binary,
    `#!${process.execPath}\n${readFileSync(new URL("../../fixtures/thread-ownership/codex-cli.cjs", import.meta.url), "utf8")}`,
  );
  const logPath = join(root, "protocol.jsonl");
  writeFileSync(logPath, "");
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    CODEX_HOME: root,
    GRAM_OWNER_LOG: logPath,
  };
  writeFileSync(
    shell,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
      `\0__SB_PROBE__\0${binary}\n\0__SB_ENV__\0${Object.entries(env)
        .map(([k, v]) => `${k}=${v}\0`)
        .join("")}`,
    )});`,
  );
  chmodSync(binary, 0o755);
  chmodSync(shell, 0o755);
  const keys = Layer.succeed(GatewayKeyProvider)({
    credentials: (id) =>
      Effect.succeed({
        profile: {
          id,
          name: "Invented gateway",
          baseURL: "https://gateway.example.invalid",
          keyRef: "invented",
          models: [],
        },
        key: Redacted.make("invented-key"),
      }),
  });
  return {
    root,
    binary,
    shell,
    keys,
    mode: (mode: string) => writeFileSync(join(root, "invented-close-mode"), mode),
    log: () =>
      readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              pid: number;
              home: string;
              msg: {
                method?: string;
                params?: { threadId?: string };
                released?: string;
                opened?: string;
              };
            },
        ),
  };
};
const identity = (session: AgentSession) =>
  session.events.pipe(
    Stream.filter((e) => e.type === "identity"),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((events) => {
      const e = events[0];
      if (e?.type !== "identity") throw new Error("Missing invented identity");
      return e.agentSessionId;
    }),
  );
const closeScope = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);
const sessionScope = Effect.acquireRelease(Scope.make(), closeScope);
const options = { threadId: ThreadId.make("invented-gram-thread"), cwd: "/invented/repo" };

const withHost = <A, E>(
  body: (
    f: ReturnType<typeof fixture>,
  ) => Effect.Effect<A, E, CodexHost | CodexServers | Scope.Scope>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(fixture),
    (f) =>
      body(f).pipe(
        Effect.scoped,
        Effect.provide(
          CodexHostLayer().pipe(
            Layer.provideMerge(
              CodexServersLive({
                binaryPath: f.binary,
                shell: f.shell,
                startupTimeoutMs: 2000,
                threadCloseTimeoutMs: 150,
                gatewayHome: () => Effect.succeed(join(f.root, "gateway-home")),
              }),
            ),
            Layer.provide(f.keys),
          ),
        ),
      ),
    (f) => Effect.sync(() => rmSync(f.root, { recursive: true, force: true })),
  );
const control = (server: CodexServer, action: string, id = "") =>
  server.rpc.request("thread/read", { threadId: `${action}:${id}` });
// A retired child stops only after its last held session closes. Subscribe before releasing it.
const releaseSibling = (server: CodexServer, scope: Scope.Closeable) =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<void>();
    yield* server.subscribe("retirement-exit-observer", {
      message: () => {},
      exit: () => Deferred.doneUnsafe(exited, Effect.void),
    });
    yield* closeScope(scope);
    yield* Deferred.await(exited).pipe(Effect.timeout("2 seconds"));
  });
const openSession = (resumeId?: string) =>
  Effect.gen(function* () {
    const scope = yield* sessionScope;
    const session = yield* (yield* CodexHost)
      .open({ ...options, ...(resumeId === undefined ? {} : { resumeId }) })
      .pipe(Effect.provideService(Scope.Scope, scope));
    return { scope, session, id: yield* identity(session) };
  });
const heldPair = Effect.gen(function* () {
  const first = yield* openSession();
  const sibling = yield* openSession();
  const servers = yield* CodexServers;
  const old = yield* servers.acquire(undefined, "user");
  return { first, sibling, old, servers };
});
const refused = (effect: Effect.Effect<unknown, AgentUnavailable, Scope.Scope>, detail?: string) =>
  effect.pipe(
    Effect.scoped,
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("Resume was refused");
        if (detail !== undefined) expect(error.message).toContain(detail);
      }),
    ),
  );

// Actual CodexHostLayer + CodexServersLive + child stdio, never a mock ownership registry.
describe.skipIf(process.platform === "win32")("Codex provider thread ownership", () => {
  for (const mode of ["persistence-failure", "silent-persistence-failure"]) {
    it.live(`retains the writer fence after ${mode} emits thread/closed`, () =>
      withHost((f) =>
        Effect.gen(function* () {
          const host = yield* CodexHost;
          const { first, sibling, old, servers } = yield* heldPair;
          f.mode(mode);
          yield* servers.retire(undefined);
          yield* closeScope(first.scope);
          yield* control(old, "await-unsubscribe", first.id);
          yield* control(old, "barrier");
          // Matching close has arrived, but the invented shared recorder still owns its writer.
          expect(
            JSON.parse(readFileSync(join(f.root, `invented-writer-${first.id}.json`), "utf8")).pid,
          ).toBe(f.log().find((row) => row.msg.method === "thread/start")!.pid);
          yield* refused(
            host.open({ ...options, resumeId: first.id }),
            "thread/closed does not prove writer release",
          );
          expect(f.log().filter((row) => row.msg.method === "thread/resume")).toHaveLength(0);
          yield* sibling.session.send({
            text: "held sibling still works after failed persistence",
          });
          yield* releaseSibling(old, sibling.scope);
          expect(yield* identity(yield* host.open({ ...options, resumeId: first.id }))).toBe(
            first.id,
          );
        }),
      ),
    );
  }

  it.live("retains even normal close until owner exit while preserving its held sibling", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const { first, sibling, old, servers } = yield* heldPair;
        yield* servers.retire(undefined);
        yield* closeScope(first.scope);
        yield* control(old, "await-unsubscribe", first.id);
        yield* control(old, "barrier");
        yield* refused(
          host.open({ ...options, resumeId: first.id }),
          "thread/closed does not prove writer release",
        );
        yield* sibling.session.send({ text: "still held" });
        yield* releaseSibling(old, sibling.scope);
        const resumed = yield* host.open({ ...options, resumeId: first.id });
        expect(yield* identity(resumed)).toBe(first.id);
        const log = f.log();
        const originalPid = log.find((row) => row.msg.method === "thread/start")!.pid;
        const close = log.findIndex((row) => row.msg.released === first.id);
        const reopen = log.findIndex(
          (row) => row.pid !== originalPid && row.msg.method === "thread/resume",
        );
        expect(close).toBeGreaterThan(-1);
        expect(reopen).toBeGreaterThan(close);
        expect(log.some((row) => row.pid === originalPid && row.msg.method === "turn/start")).toBe(
          true,
        );
      }),
    ),
  );

  for (const mode of ["delayed", "notLoaded", "notSubscribed", "unknown", "error", "no-reply"]) {
    it.live(`retains refusal after ${mode} unsubscribe even after a late matching close`, () =>
      withHost((f) =>
        Effect.gen(function* () {
          const host = yield* CodexHost;
          const { first, sibling, old, servers } = yield* heldPair;
          f.mode(mode);
          yield* servers.retire(undefined);
          yield* closeScope(first.scope);
          yield* control(old, "await-unsubscribe", first.id);
          const next = yield* servers.acquire(undefined, "user");
          yield* refused(host.open({ ...options, resumeId: first.id }));
          expect(f.log().filter((row) => row.msg.method === "thread/resume")).toHaveLength(0);
          yield* sibling.session.send({ text: "still held" });
          // An acknowledgement from another child or for another thread does not release this fence.
          yield* control(next, "stale", first.id);
          yield* control(old, "stale", "unrelated-thread");
          yield* refused(host.open({ ...options, resumeId: first.id }));
          yield* control(old, "close", first.id);
          yield* refused(
            host.open({ ...options, resumeId: first.id }),
            "thread/closed does not prove writer release",
          );
          yield* releaseSibling(old, sibling.scope);
          expect(yield* identity(yield* host.open({ ...options, resumeId: first.id }))).toBe(
            first.id,
          );
        }),
      ),
    );
  }

  it.live("counts multiple Gram scopes on one thread across retirement", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const { first, sibling, old, servers } = yield* heldPair;
        const second = yield* openSession(first.id);
        yield* servers.retire(undefined);
        yield* closeScope(first.scope);
        yield* control(old, "barrier");
        expect(f.log().filter((row) => row.msg.method === "thread/unsubscribe")).toHaveLength(0);
        yield* refused(host.open({ ...options, resumeId: first.id }), "1 Gram scope");
        yield* second.session.send({ text: "same thread still held" });
        yield* closeScope(second.scope);
        yield* refused(host.open({ ...options, resumeId: first.id }));
        yield* releaseSibling(old, sibling.scope);
        expect(yield* identity(yield* host.open({ ...options, resumeId: first.id }))).toBe(
          first.id,
        );
        expect(
          f
            .log()
            .filter(
              (row) =>
                row.msg.method === "thread/unsubscribe" && row.msg.params?.threadId === first.id,
            ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.live("ordinary close retires the exact child only after its last same-thread scope", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const { first, sibling, old, servers } = yield* heldPair;
        const second = yield* openSession(first.id);
        yield* closeScope(first.scope);
        yield* control(old, "barrier");
        expect(yield* old.configCurrent).toBe(true);
        expect(f.log().filter((row) => row.msg.method === "thread/unsubscribe")).toHaveLength(0);
        yield* second.session.send({ text: "remaining same-thread scope works" });
        yield* closeScope(second.scope);
        yield* control(old, "await-unsubscribe", first.id);
        expect(yield* old.configCurrent).toBe(false);
        const replacement = yield* servers.acquire(undefined, "user");
        expect(replacement).not.toBe(old);
        yield* refused(host.open({ ...options, resumeId: first.id }));
        yield* sibling.session.send({ text: "held sibling survives ordinary retirement" });
        yield* releaseSibling(old, sibling.scope);
        expect(yield* replacement.configCurrent).toBe(true);
        expect(yield* identity(yield* host.open({ ...options, resumeId: first.id }))).toBe(
          first.id,
        );
        expect(
          f
            .log()
            .filter(
              (row) =>
                row.msg.method === "thread/unsubscribe" && row.msg.params?.threadId === first.id,
            ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.live(
    "serializes concurrent replacement resumes across owner exit and shares their references",
    () =>
      withHost((f) =>
        Effect.gen(function* () {
          const { first, sibling, old, servers } = yield* heldPair;
          f.mode("delayed");
          yield* servers.retire(undefined);
          yield* closeScope(first.scope);
          yield* control(old, "await-unsubscribe", first.id);
          const host = yield* CodexHost;
          yield* control(old, "close", first.id);
          yield* Effect.all(
            [
              refused(host.open({ ...options, resumeId: first.id })),
              refused(host.open({ ...options, resumeId: first.id })),
            ],
            { concurrency: "unbounded" },
          );
          expect(f.log().filter((row) => row.msg.method === "thread/resume")).toHaveLength(0);
          const one = yield* Effect.forkScoped(openSession(first.id));
          const two = yield* Effect.forkScoped(openSession(first.id));
          yield* releaseSibling(old, sibling.scope);
          const a = yield* Fiber.join(one),
            b = yield* Fiber.join(two);
          expect(a.id).toBe(first.id);
          expect(b.id).toBe(first.id);
          const log = f.log();
          const closed = log.findIndex((row) => row.msg.released === first.id);
          expect(
            log.filter((row, index) => row.msg.method === "thread/resume" && index > closed),
          ).toHaveLength(2);
          const next = yield* servers.acquire(undefined, "user");
          yield* closeScope(a.scope);
          yield* control(next, "barrier");
          expect(
            f
              .log()
              .filter(
                (row) =>
                  row.msg.method === "thread/unsubscribe" && row.msg.params?.threadId === first.id,
              ),
          ).toHaveLength(1);
          yield* b.session.send({ text: "remaining reference" });
        }),
      ),
  );

  it.live("does not cancel pending provider unload by resuming on the same child", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const { first, sibling, old, servers } = yield* heldPair;
        f.mode("delayed");
        // A close sent while still active is stale for the later close lifecycle.
        yield* control(old, "stale", first.id);
        yield* closeScope(first.scope);
        yield* control(old, "await-unsubscribe", first.id);
        yield* refused(host.open({ ...options, resumeId: first.id }));
        expect(f.log().filter((row) => row.msg.method === "thread/resume")).toHaveLength(0);
        yield* control(old, "close", first.id);
        yield* refused(host.open({ ...options, resumeId: first.id }));
        yield* servers.retire(undefined);
        yield* releaseSibling(old, sibling.scope);
        expect(yield* identity(yield* host.open({ ...options, resumeId: first.id }))).toBe(
          first.id,
        );
      }),
    ),
  );

  it.live("reserves a reference while resume is in flight so close cannot unsubscribe it", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const { first, old } = yield* heldPair;
        yield* control(old, "hold-resume");
        const pending = yield* Effect.forkScoped(openSession(first.id));
        yield* control(old, "await-resume");
        yield* closeScope(first.scope);
        yield* control(old, "barrier");
        expect(f.log().filter((row) => row.msg.method === "thread/unsubscribe")).toHaveLength(0);
        yield* control(old, "release-resume");
        const resumed = yield* Fiber.join(pending);
        expect(resumed.id).toBe(first.id);
        yield* resumed.session.send({ text: "after concurrent close" });
        yield* closeScope(resumed.scope);
        yield* control(old, "await-unsubscribe", first.id);
        expect(
          f
            .log()
            .filter(
              (row) =>
                row.msg.method === "thread/unsubscribe" && row.msg.params?.threadId === first.id,
            ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.live("owning child exit releases pending closures without a close notification", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const { first, old, servers } = yield* heldPair;
        f.mode("no-reply");
        const exited = yield* Deferred.make<void>();
        yield* old.subscribe("exit-observer", {
          message: () => {},
          exit: () => {
            Deferred.doneUnsafe(exited, Effect.void);
          },
        });
        yield* servers.retire(undefined);
        yield* closeScope(first.scope);
        yield* control(old, "await-unsubscribe", first.id);
        yield* control(old, "exit").pipe(Effect.ignore);
        yield* Deferred.await(exited);
        expect(yield* identity(yield* host.open({ ...options, resumeId: first.id }))).toBe(
          first.id,
        );
      }),
    ),
  );

  it.live("observes child exit between the open reply and ownership/listener registration", () =>
    withHost(() =>
      Effect.gen(function* () {
        const servers = yield* CodexServers;
        const old = yield* servers.acquire(undefined, "user");
        const exited = yield* Deferred.make<void>();
        yield* old.subscribe("exit-observer", {
          message: () => {},
          exit: () => {
            Deferred.doneUnsafe(exited, Effect.void);
          },
        });
        let id = "";
        const result = yield* old
          .openThread(
            undefined,
            Effect.gen(function* () {
              const started = yield* old.rpc.request("thread/start", { cwd: options.cwd });
              id = started.thread.id;
              yield* control(old, "exit").pipe(Effect.ignore);
              yield* Deferred.await(exited);
              return started;
            }),
          )
          .pipe(Effect.flip);
        expect(result.message).toContain("exited during open");
        const lateExit = yield* Deferred.make<void>();
        yield* old.subscribe(id, {
          message: () => {},
          exit: () => {
            Deferred.doneUnsafe(lateExit, Effect.void);
          },
        });
        yield* Deferred.await(lateExit);
        expect(yield* identity(yield* (yield* CodexHost).open({ ...options, resumeId: id }))).toBe(
          id,
        );
      }),
    ),
  );

  it.live("keeps equal thread ids independent on separate physical homes", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const { first, old, servers } = yield* heldPair;
        f.mode("delayed");
        yield* servers.retire(undefined);
        yield* closeScope(first.scope);
        yield* control(old, "await-unsubscribe", first.id);
        const other = yield* host.open({ ...options, resumeId: first.id, codexHome: "gateway" });
        expect(yield* identity(other)).toBe(first.id);
        yield* other.send({ text: "independent home" });
        yield* refused(host.open({ ...options, resumeId: first.id, codexHome: "user" }));
        const resumeHomes = f
          .log()
          .filter((row) => row.msg.method === "thread/resume")
          .map((row) => row.home);
        expect(resumeHomes).toEqual([join(f.root, "gateway-home")]);
      }),
    ),
  );

  it.live("resolves a home alias before fencing another server identity", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const { first } = yield* heldPair;
        symlinkSync(f.root, join(f.root, "gateway-home"));
        yield* refused(
          host.open({ ...options, resumeId: first.id, codexHome: "gateway" }),
          "Gram scope",
        );
        expect(f.log().filter((row) => row.msg.method === "thread/resume")).toHaveLength(0);
      }),
    ),
  );

  it.live(
    "owns a successfully opened thread even when post-open confinement validation fails",
    () =>
      withHost((f) =>
        Effect.gen(function* () {
          const host = yield* CodexHost;
          const { first, sibling, old, servers } = yield* heldPair;
          const failedScope = yield* sessionScope;
          const error = yield* host
            .open({ ...options, confineWrites: true })
            .pipe(Effect.provideService(Scope.Scope, failedScope), Effect.flip);
          expect(error.message).toContain("kept alpha on");
          const id = f
            .log()
            .filter((row) => row.msg.opened !== undefined)
            .at(-1)!.msg.opened!;
          yield* closeScope(failedScope);
          yield* control(old, "await-unsubscribe", id);
          yield* refused(host.open({ ...options, resumeId: id }));
          yield* servers.retire(undefined);
          yield* closeScope(first.scope);
          yield* releaseSibling(old, sibling.scope);
          expect(yield* identity(yield* host.open({ ...options, resumeId: id }))).toBe(id);
        }),
      ),
  );

  it.live(
    "an unsettled resume cannot use a close notification as proof that a later writer won't load",
    () =>
      withHost((f) =>
        Effect.gen(function* () {
          const host = yield* CodexHost;
          const { first, old, servers } = yield* heldPair;
          yield* control(old, "hold-resume");
          const clock = yield* TestClock.make();
          const opening = yield* host
            .open({ ...options, resumeId: first.id })
            .pipe(Effect.provideService(Clock.Clock, clock), Effect.flip, Effect.forkScoped);
          // The child has loaded its writer and withheld the reply. Advance only that timeout,
          // after the handshake, rather than spending two real seconds of the test's five.
          yield* control(old, "await-resume");
          yield* clock.adjust("2 seconds");
          const error = yield* Fiber.join(opening);
          expect(error.message).toContain("provider open gave no answer");
          yield* servers.retire(undefined);
          yield* closeScope(first.scope);
          // The failed open reserved a reference in its scope. Closing that scope must not weaken the fence.
          // Use a separate bounded scope for another unsettled open to exercise its cleanup explicitly.
          yield* control(old, "release-resume");
          const unknownScope = yield* sessionScope;
          yield* refused(
            host
              .open({ ...options, resumeId: first.id })
              .pipe(Effect.provideService(Scope.Scope, unknownScope)),
          );
          yield* closeScope(unknownScope);
          yield* control(old, "stale", first.id);
          yield* refused(host.open({ ...options, resumeId: first.id }));
          const exited = yield* Deferred.make<void>();
          yield* old.subscribe("exit-observer", {
            message: () => {},
            exit: () => {
              Deferred.doneUnsafe(exited, Effect.void);
            },
          });
          yield* control(old, "exit").pipe(Effect.ignore);
          yield* Deferred.await(exited);
          expect(yield* identity(yield* host.open({ ...options, resumeId: first.id }))).toBe(
            first.id,
          );
          expect(f.log().filter((row) => row.msg.method === "thread/resume")).toHaveLength(2);
        }),
      ),
  );

  it.live(
    "a new open with unknown identity refuses further opens on its home until owner exit",
    () =>
      withHost(() =>
        Effect.gen(function* () {
          const host = yield* CodexHost;
          const { sibling, old, servers } = yield* heldPair;
          yield* control(old, "hold-open");
          const error = yield* host.open(options).pipe(Effect.flip);
          expect(error.message).toContain("provider open gave no answer");
          yield* servers.retire(undefined);
          yield* refused(host.open(options), "unknown identity");
          yield* sibling.session.send({ text: "held sibling still works" });
          const exited = yield* Deferred.make<void>();
          yield* old.subscribe("exit-observer", {
            message: () => {},
            exit: () => {
              Deferred.doneUnsafe(exited, Effect.void);
            },
          });
          yield* control(old, "exit").pipe(Effect.ignore);
          yield* Deferred.await(exited);
          expect(yield* identity(yield* host.open(options))).not.toBe("");
        }),
      ),
  );

  it.live("does not share ownership across credential identities using the same home", () =>
    withHost((f) =>
      Effect.gen(function* () {
        const host = yield* CodexHost;
        const { first } = yield* heldPair;
        yield* refused(
          host.open({
            ...options,
            resumeId: first.id,
            codexHome: "user",
            model: {
              agent: "codex",
              model: "invented-model",
              profileId: ProfileId.make("invented-gateway"),
            },
          }),
          "Gram scope",
        );
        expect(f.log().filter((row) => row.msg.method === "thread/resume")).toHaveLength(0);
      }),
    ),
  );
});
