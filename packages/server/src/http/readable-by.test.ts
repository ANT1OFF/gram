// The acceptance test for threads readable by one person (`embedding/readable-by.ts`): a whole
// server over a real socket, behind a synthetic proxy. An embedder starts a thread from a profile
// for Ada alone; Mo, a member, and Vera, a viewer, get nothing of it on any path, list, read,
// event, search, another thread's tools or a write, while Ada gets all of it. What it spawns keeps
// its reader, nothing clears it, and a thread started for nobody in particular is everyone's.
import { randomBytes } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, layer, test } from "@effect/vitest";
import {
  GramRpcs,
  PROFILE_START_PATH,
  type ServerEvent,
  ThreadId,
  type ThreadFeedEvent,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AppToolRegistry, WRITES_STAY_PRIVATE } from "../app-tools/registry.ts";
import { SHARED_MACHINE } from "../rpc/handlers/terminal.ts";
import { ServerConfig } from "../config.ts";
import { logLinesFor, NOT_READABLE, ReadingAs } from "../embedding/readable-by.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { removeDir } from "../git/test-repo.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { IDENTITY_HEADER, SERVICE_TYP } from "./fronted-identity.ts";
import { makeTestProxy } from "./fronted-identity.testing.ts";
import { ASK_ANSWER_PATH } from "../embedding/ask-answer.ts";
import { WORKSPACE_EXPORT_PATH } from "../transfer/routes.ts";
import { LaunchToken, serverPort, ServerLayer } from "./server.ts";

const proxy = makeTestProxy();

const PRIVATE = ThreadId.make("7c2e3b01-4d5f-4a6b-9c7d-8e9f0a1b2c3d");
const OPEN = ThreadId.make("7c2e3b01-4d5f-4a6b-9c7d-8e9f0a1b2c3e");

const ada = { sub: "ada", name: "Ada", role: "member" };
const mo = { sub: "mo", name: "Mo", role: "member" };
const vera = { sub: "vera", name: "Vera", role: "viewer" };

const dirs: string[] = [];
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "gram-readable-by-"));
  dirs.push(made);
  return made;
};

const server = (embedding: boolean, fronted = true) =>
  ServerLayer.pipe(
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
    Layer.provide(TurnHooks.layerNoop),
    Layer.provide(gitPlatformTest()),
    Layer.provide(
      ServerConfig.layer({
        ...TEST_CONFIG,
        dataDir: folder(),
        ...(fronted ? { frontedIdentity: proxy.config } : {}),
        embedding,
      }),
    ),
    Layer.orDie,
  );

const info = Effect.gen(function* () {
  const { token } = yield* LaunchToken;
  return { port: serverPort(yield* HttpServer.HttpServer), token };
});

const send = (
  port: number,
  method: "GET" | "POST",
  path: string,
  body: string | undefined,
  headers: Record<string, string>,
) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string; setCookie: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method,
            agent: false,
            headers: {
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": String(Buffer.byteLength(body)),
                  }),
              ...headers,
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: text,
                setCookie: res.headers["set-cookie"]?.[0] ?? "",
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      }),
  );

/** An RPC client whose connection carries `headers`, living in the caller's scope. */
const client = (port: number, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor)(
            (url) =>
              new (globalThis.WebSocket as unknown as new (
                url: string,
                init: { headers: Record<string, string> },
              ) => globalThis.WebSocket)(url, { headers }),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
  });

const as = (port: number, claims: Record<string, unknown>) =>
  client(port, { [IDENTITY_HEADER]: proxy.statement(claims) });

type Client = Effect.Success<ReturnType<typeof as>>;

/** Why a call was refused, as the server said it; or that it went through. */
const outcome = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(call), (exit) =>
    Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "the call went through",
  );

/** The platform's own start of a thread from a profile, as an embedding host makes it. */
const start = (port: number, threadId: ThreadId, extra: Record<string, unknown> = {}) =>
  send(
    port,
    "POST",
    PROFILE_START_PATH,
    JSON.stringify({
      profile: {
        version: 1,
        agent: "claude",
        charter: "Synthetic charter.",
        model: { model: "fake-model" },
        connectors: {},
        workplace: { kind: "scratch" },
        input: threadId === PRIVATE ? "the secret plan" : "the open plan",
      },
      threadId,
      ...extra,
    }),
    {
      host: `127.0.0.1:${port}`,
      origin: proxy.config.origin,
      [IDENTITY_HEADER]: proxy.statement(
        { sub: "platform", role: "service", path: PROFILE_START_PATH },
        { header: { typ: SERVICE_TYP } },
      ),
    },
  );

/** Runs an agent tool as `threadId`'s agent, through the registry's own binding. */
const tool = (threadId: ThreadId, name: string, input: unknown) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const bound = registry.forTransport(threadId).find((t) => t.descriptor.name === name);
    if (bound === undefined) return yield* Effect.die(new Error(`no app tool ${name}`));
    return yield* bound.run(input);
  });

/** Every event a connection is sent, from its first snapshot on. */
const listen = (who: Client) =>
  Effect.gen(function* () {
    const heard: Array<ServerEvent> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(who["events.subscribe"](), (event) => Effect.sync(() => heard.push(event))),
    );
    yield* waitReal(
      "the snapshot",
      Effect.sync(() => heard.length > 0),
    );
    return heard;
  });

/** Whether an event is anything of `threadId`'s. */
const mentions = (event: ServerEvent, threadId: ThreadId): boolean =>
  JSON.stringify(event).includes(threadId);

const idle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitReal(
      `${threadId} idle with its reply`,
      Effect.gen(function* () {
        if ((yield* runtimes.status(threadId)) !== "idle") return false;
        return (yield* (yield* ThreadStore).messageCount(threadId)) >= 2;
      }),
    );
  });

/** The threads a connection's first list names. */
const listed = (heard: ReadonlyArray<ServerEvent>) => {
  const first = heard[0];
  return first?.type === "threads.snapshot"
    ? first.threads.map((summary) => summary.thread.id)
    : [];
};

/** A thread's stored transcript, as a connection that opens it is sent it. */
const feed = (who: Client, threadId: ThreadId) =>
  who["thread.subscribe"]({ threadId }).pipe(
    Stream.takeUntil((event: ThreadFeedEvent) => event.type === "caughtUp"),
    Stream.runCollect,
  );

/** The threads a search finds, each once. */
const found = (who: Client, query: string) =>
  Effect.map(who["thread.search"]({ query }), (result) => [
    ...new Set(result.hits.map((hit) => hit.threadId)),
  ]);

/** The terminals a connection is listed. */
const terminalsOf = (who: Client) =>
  Effect.map(who["terminal.list"]({}), (all) => all.map((t) => t.terminalId));

describe("threads readable by one person", () => {
  afterAll(() => {
    for (const dir of dirs) removeDir(dir);
  });

  layer(server(true), { excludeTestServices: true })("behind a fronting proxy", (it) => {
    it.effect("show nothing of themselves to anyone else, and everything to their reader", () =>
      Effect.gen(function* () {
        const { port } = yield* info;
        const started = yield* start(port, PRIVATE, { readableBy: "ada" });
        expect(started.status, started.body).toBe(200);
        expect(JSON.parse(started.body)).toEqual({
          threadId: PRIVATE,
          created: true,
          readableBy: "ada",
        });
        const open = yield* start(port, OPEN);
        expect(JSON.parse(open.body)).toEqual({ threadId: OPEN, created: true });
        yield* idle(PRIVATE);
        yield* idle(OPEN);
        expect((yield* (yield* ThreadStore).getThread(PRIVATE)).readableBy).toBe("ada");

        const adaClient = yield* as(port, ada);
        const moClient = yield* as(port, mo);
        const veraClient = yield* as(port, vera);
        const heardBy = {
          ada: yield* listen(adaClient),
          mo: yield* listen(moClient),
          vera: yield* listen(veraClient),
        };

        // The sidebar's first list: the open thread for all, the private one for Ada alone.
        expect(listed(heardBy.ada)).toEqual(expect.arrayContaining([PRIVATE, OPEN]));
        for (const other of [heardBy.mo, heardBy.vera]) {
          expect(listed(other)).toContain(OPEN);
          expect(listed(other)).not.toContain(PRIVATE);
        }

        // Its transcript, and any call that names it, is Ada's alone, a viewer's read included.
        expect(JSON.stringify(yield* feed(adaClient, PRIVATE))).toContain("the secret plan");
        expect(JSON.stringify(yield* feed(moClient, OPEN))).toContain("the open plan");
        for (const who of [moClient, veraClient]) {
          expect(yield* outcome(feed(who, PRIVATE))).toContain(NOT_READABLE);
          expect(yield* outcome(who["thread.listWaits"]({ threadId: PRIVATE }))).toContain(
            NOT_READABLE,
          );
          expect(
            yield* outcome(who["thread.search"]({ query: "secret", threadId: PRIVATE })),
          ).toContain(NOT_READABLE);
        }

        // Search finds it for Ada, and for nobody else, its title included.
        expect(yield* found(adaClient, "secret")).toContain(PRIVATE);
        for (const who of [moClient, veraClient]) {
          expect(yield* found(who, "secret")).toEqual([]);
          expect(yield* found(who, "plan")).toEqual([OPEN]);
        }

        // Only Ada writes to it: a send, an interrupt and an answer of anyone else's are refused.
        for (const who of [moClient, veraClient]) {
          expect(
            yield* outcome(
              who["thread.send"]({
                threadId: PRIVATE,
                input: { text: "let me in" },
                clientMessageId: `try-${randomBytes(4).toString("hex")}`,
              }),
            ),
          ).toContain(NOT_READABLE);
          expect(yield* outcome(who["thread.interrupt"]({ threadId: PRIVATE }))).toContain(
            NOT_READABLE,
          );
        }
        expect(
          yield* outcome(
            adaClient["thread.send"]({
              threadId: PRIVATE,
              input: { text: "the second secret" },
              clientMessageId: `ada-${randomBytes(4).toString("hex")}`,
            }),
          ),
        ).toBe("the call went through");
        // Mo's own send to the open thread is the marker that his connection is caught up.
        yield* moClient["thread.send"]({
          threadId: OPEN,
          input: { text: "an open word" },
          clientMessageId: `mo-${randomBytes(4).toString("hex")}`,
        });
        yield* waitReal(
          "Ada told of her thread's new turn, and everyone of the open one's",
          Effect.sync(
            () =>
              heardBy.ada.slice(1).some((event) => mentions(event, PRIVATE)) &&
              [heardBy.mo, heardBy.vera].every((heard) =>
                heard.slice(1).some((event) => mentions(event, OPEN)),
              ),
          ),
        );
        yield* idle(PRIVATE);
        yield* idle(OPEN);
        for (const heard of [heardBy.mo, heardBy.vera])
          expect(heard.filter((event) => mentions(event, PRIVATE))).toEqual([]);

        // Another thread's agent can't see it either: not listed, found, read or messaged.
        const listedByTool = (caller: ThreadId) =>
          Effect.map(tool(caller, "list_threads", {}), (result) =>
            (result as { threads: ReadonlyArray<{ threadId: string }> }).threads.map(
              (thread) => thread.threadId,
            ),
          );
        expect(yield* listedByTool(OPEN)).not.toContain(PRIVATE);
        expect(yield* listedByTool(PRIVATE)).toEqual(expect.arrayContaining([PRIVATE, OPEN]));
        const searched = yield* tool(OPEN, "search_threads", { query: "secret" });
        expect(JSON.stringify(searched)).not.toContain(PRIVATE);
        for (const [name, input] of [
          ["get_thread", { threadId: PRIVATE }],
          ["list_events", { threadId: PRIVATE }],
          ["git_state", { threadId: PRIVATE }],
          ["send_message", { threadId: PRIVATE, message: "what are you doing?" }],
          ["stop_thread", { threadId: PRIVATE }],
        ] as const)
          expect(yield* outcome(tool(OPEN, name, input)), name).toContain(
            `unknown thread ${PRIVATE}`,
          );
        expect(JSON.stringify(yield* tool(PRIVATE, "get_thread", { threadId: PRIVATE }))).toContain(
          "the secret plan",
        );
      }),
    );

    it.effect("keep their folders from anyone else, by any path that leads there", () =>
      Effect.gen(function* () {
        const { port } = yield* info;
        const store = yield* ThreadStore;
        const folderOf = (threadId: ThreadId) =>
          Effect.map(store.getThread(threadId), (thread) => thread.checkout.path);
        const privateFolder = yield* folderOf(PRIVATE);
        const openFolder = yield* folderOf(OPEN);
        writeFileSync(join(privateFolder, "AGENTS.md"), "the secret instructions");
        const parent = dirname(privateFolder);
        const linkDir = folder();
        const link = join(linkDir, "shortcut");
        symlinkSync(privateFolder, link);

        const adaClient = yield* as(port, ada);
        const moClient = yield* as(port, mo);

        // Every spelling of the folder: as it is, through a link, with `..`, and relative to a
        // thread the caller may read.
        const ways = [
          { path: privateFolder },
          { path: link },
          { path: `${openFolder}/../${basename(privateFolder)}` },
          { path: `../${basename(privateFolder)}`, threadId: OPEN },
        ];
        for (const way of ways) {
          expect(yield* outcome(moClient["fs.list"](way)), way.path).toContain(NOT_READABLE);
          expect(yield* outcome(moClient["fs.files"](way)), way.path).toContain(NOT_READABLE);
        }
        for (const path of [privateFolder, link, `${openFolder}/../${basename(privateFolder)}`])
          expect(yield* outcome(moClient["worktree.status"]({ path })), path).toContain(
            NOT_READABLE,
          );
        expect(
          yield* outcome(moClient["fs.list"]({ path: join(privateFolder, "AGENTS.md") })),
        ).toContain(NOT_READABLE);

        // A folder above it lists everything but the thread's folder.
        const listedNames = (who: Client) =>
          Effect.map(who["fs.list"]({ path: parent, showHidden: true }), (listing) =>
            listing.entries.map((entry) => entry.name),
          );
        expect(yield* listedNames(adaClient)).toEqual(
          expect.arrayContaining([basename(privateFolder), basename(openFolder)]),
        );
        const moNames = yield* listedNames(moClient);
        expect(moNames).toContain(basename(openFolder));
        expect(moNames).not.toContain(basename(privateFolder));
        const moFiles = yield* moClient["fs.files"]({ path: parent });
        expect(
          moFiles.entries.filter((entry) => entry.path.startsWith(basename(privateFolder))),
        ).toEqual([]);

        // Ada reaches it every way a folder outside a thread is reached; the relative way is
        // the open thread's folder's to refuse, as it refuses anyone.
        for (const way of ways.slice(0, 3)) {
          expect(JSON.stringify(yield* adaClient["fs.list"](way)), way.path).toContain("AGENTS.md");
          expect(JSON.stringify(yield* adaClient["fs.files"](way)), way.path).toContain(
            "AGENTS.md",
          );
        }
        expect(yield* outcome(adaClient["worktree.status"]({ path: privateFolder }))).not.toContain(
          NOT_READABLE,
        );
      }),
    );

    it.effect("keep their content off the routes outside the socket too", () =>
      Effect.gen(function* () {
        const { port } = yield* info;
        const store = yield* ThreadStore;
        const privateFolder = (yield* store.getThread(PRIVATE)).checkout.path;
        writeFileSync(join(privateFolder, "NOTES.md"), "the secret notes");
        const adaClient = yield* as(port, ada);
        const moClient = yield* as(port, mo);

        // An answer to one of its asks, over its own HTTP route.
        const answer = (claims: Record<string, unknown>) =>
          send(
            port,
            "POST",
            ASK_ANSWER_PATH,
            JSON.stringify({
              threadId: PRIVATE,
              requestId: "no-such-request",
              answer: { kind: "approval", decision: "allow", scope: "once" },
            }),
            { [IDENTITY_HEADER]: proxy.statement(claims) },
          );
        const moAnswer = yield* answer(mo);
        expect(moAnswer.status).toBe(404);
        expect(moAnswer.body).toContain(NOT_READABLE);
        expect((yield* answer(ada)).body).not.toContain(NOT_READABLE);

        // A file of its, and an attachment, as the app fetches them to show.
        const preview = (who: Client) => who["fs.preview"]({ threadId: PRIVATE, path: "NOTES.md" });
        expect(yield* outcome(preview(moClient))).toContain(NOT_READABLE);
        expect(JSON.stringify(yield* preview(adaClient))).toContain("the secret notes");
        expect(
          yield* outcome(moClient["attachment.read"]({ threadId: PRIVATE, path: "a.png" })),
        ).toContain(NOT_READABLE);
      }),
    );

    it.effect("keep their shells, dreams and messages to themselves", () =>
      Effect.gen(function* () {
        const { port } = yield* info;
        const store = yield* ThreadStore;
        const adaClient = yield* as(port, ada);
        const moClient = yield* as(port, mo);

        // A terminal that is no thread's, opened by Ada in her thread's folder: Mo neither lists
        // it, reads it nor types into it. Nor does he open a shell on the machine that holds it.
        const privateFolder = (yield* store.getThread(PRIVATE)).checkout.path;
        const terminal = yield* adaClient["terminal.open"]({
          cwd: privateFolder,
          cols: 80,
          rows: 24,
        });
        expect(yield* terminalsOf(adaClient)).toContain(terminal.terminalId);
        expect(yield* terminalsOf(moClient)).not.toContain(terminal.terminalId);
        expect(
          yield* outcome(
            moClient["terminal.subscribe"]({ terminalId: terminal.terminalId }).pipe(
              Stream.take(1),
              Stream.runCollect,
            ),
          ),
        ).toContain(NOT_READABLE);
        expect(
          yield* outcome(
            moClient["terminal.input"]({ terminalId: terminal.terminalId, data: "ls\n" }),
          ),
        ).toContain(NOT_READABLE);
        expect(
          yield* outcome(moClient["terminal.close"]({ terminalId: terminal.terminalId })),
        ).toContain(NOT_READABLE);
        expect(yield* outcome(moClient["terminal.open"]({ cols: 80, rows: 24 }))).toContain(
          SHARED_MACHINE,
        );
        expect(
          yield* outcome(
            adaClient["terminal.input"]({ terminalId: terminal.terminalId, data: "\n" }),
          ),
        ).toBe("the call went through");
        yield* adaClient["terminal.close"]({ terminalId: terminal.terminalId });

        // A dream of a workspace that is Ada's, asked for by its id alone.
        const runtimes = yield* ThreadRuntimes;
        const workspaceId = "ws-ada-dreams";
        const thread = yield* runtimes.create({
          projectRoot: folder(),
          checkout: { kind: "main", path: folder() },
          deferOpen: true,
          readableBy: "ada",
          workspaceId: workspaceId as never,
        });
        const dreamId = "dream-of-ada-0001";
        yield* store.putDream({
          id: dreamId,
          workspaceId,
          kind: "dream",
          mode: "review",
          status: "completed",
          inputs: { memoryVersion: "", threadIds: [], agentSessions: [] },
          model: thread.model,
          outputDir: folder(),
          createdAt: 1,
        } as never);
        for (const call of [
          moClient["dream.review"]({ dreamId } as never),
          moClient["dream.discard"]({ dreamId } as never),
        ])
          expect(yield* outcome(call as Effect.Effect<unknown, unknown>)).toContain(NOT_READABLE);
        expect(yield* outcome(adaClient["dream.review"]({ dreamId } as never))).not.toContain(
          NOT_READABLE,
        );

        // Ada's thread's agent writes into no thread of another reader, everyone's included.
        expect(
          yield* outcome(tool(PRIVATE, "send_message", { threadId: OPEN, message: "the secret" })),
        ).toContain(WRITES_STAY_PRIVATE);
      }),
    );

    it.effect("keep their reader for good, and give it to every thread they spawn", () =>
      Effect.gen(function* () {
        const { port } = yield* info;
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;

        // Asked for again, a start must name the same reader, or none where the first named none.
        for (const readableBy of ["mo", undefined])
          expect(
            (yield* start(port, PRIVATE, readableBy === undefined ? {} : { readableBy })).status,
          ).toBe(409);
        expect((yield* start(port, OPEN, { readableBy: "ada" })).status).toBe(409);
        expect(JSON.parse((yield* start(port, PRIVATE, { readableBy: "ada" })).body)).toMatchObject(
          {
            created: false,
            readableBy: "ada",
          },
        );
        expect(
          (yield* start(port, ThreadId.make("7c2e3b01-4d5f-4a6b-9c7d-8e9f0a1b2c40"), {
            readableBy: "not a subject",
          })).status,
        ).toBe(409);

        // No write clears it or hands it to someone else.
        yield* store.updateThread(PRIVATE, (thread) => {
          const { readableBy: _, ...rest } = thread;
          return rest;
        });
        yield* store.updateThread(PRIVATE, (thread) => ({ ...thread, readableBy: "mo" }));
        expect((yield* store.getThread(PRIVATE)).readableBy).toBe("ada");
        yield* store.updateThread(OPEN, (thread) => ({ ...thread, readableBy: "mo" }));
        expect((yield* store.getThread(OPEN)).readableBy).toBeUndefined();

        // A worker it spawns is Ada's alone, whatever its start said, and so is any thread its
        // agent makes in a tool call; one the open thread spawns is everyone's.
        const made = (input: Partial<Parameters<typeof runtimes.create>[0]>) =>
          runtimes.create({
            projectRoot: folder(),
            checkout: { kind: "main", path: folder() },
            deferOpen: true,
            ...input,
          });
        const worker = yield* made({ spawnedBy: { threadId: PRIVATE, feature: "f" } });
        expect(worker.readableBy).toBe("ada");
        const widened = yield* made({
          spawnedBy: { threadId: PRIVATE, feature: "f" },
          readableBy: "mo",
        });
        expect(widened.readableBy).toBe("ada");
        const fromTool = yield* made({}).pipe(
          Effect.provideService(ReadingAs, { subject: "ada", fromThread: true }),
        );
        expect(fromTool.readableBy).toBe("ada");
        const openWorker = yield* made({ spawnedBy: { threadId: OPEN, feature: "f" } });
        expect(openWorker.readableBy).toBeUndefined();

        // The worker is as closed to Mo as its spawner.
        const moClient = yield* as(port, mo);
        expect(yield* outcome(moClient["thread.listWaits"]({ threadId: worker.id }))).toContain(
          NOT_READABLE,
        );
        expect(yield* outcome(moClient["thread.listWaits"]({ threadId: openWorker.id }))).toBe(
          "the call went through",
        );
      }),
    );
  });

  layer(server(false), { excludeTestServices: true })("with no signed-in person", (it) => {
    it.effect("are shown to no one, failing closed", () =>
      Effect.gen(function* () {
        const { port, token } = yield* info;
        const runtimes = yield* ThreadRuntimes;
        const host = { host: `127.0.0.1:${port}` };
        const boot = yield* send(port, "GET", `/?boot=${token}`, undefined, host);
        const app = yield* client(port, { ...host, cookie: boot.setCookie.split(";")[0] ?? "" });
        const hidden = yield* runtimes.create({
          projectRoot: folder(),
          checkout: { kind: "main", path: folder() },
          deferOpen: true,
          readableBy: "ada",
          title: "hidden plan",
        });
        const shown = yield* runtimes.create({
          projectRoot: folder(),
          checkout: { kind: "main", path: folder() },
          deferOpen: true,
          title: "shown plan",
        });
        const heard = yield* listen(app);
        const first = heard[0];
        const ids = first?.type === "threads.snapshot" ? first.threads.map((s) => s.thread.id) : [];
        expect(ids).toContain(shown.id);
        expect(ids).not.toContain(hidden.id);
        expect(yield* outcome(app["thread.listWaits"]({ threadId: hidden.id }))).toContain(
          NOT_READABLE,
        );
        const hits = (yield* app["thread.search"]({ query: "plan" })).hits;
        expect([...new Set(hits.map((hit) => hit.threadId))]).toEqual([shown.id]);
      }),
    );
  });

  layer(server(true, false), { excludeTestServices: true })(
    "with the hosted features on and nobody signed in through a proxy",
    (it) => {
      it.effect("are no one's to take out over a route of the local app's", () =>
        Effect.gen(function* () {
          const { port, token } = yield* info;
          const runtimes = yield* ThreadRuntimes;
          const host = { host: `127.0.0.1:${port}` };
          const boot = yield* send(port, "GET", `/?boot=${token}`, undefined, host);
          const local = {
            ...host,
            cookie: boot.setCookie.split(";")[0] ?? "",
            origin: `http://127.0.0.1:${port}`,
          };
          // A workspace whose threads are Ada's: the local app, signed in as no one, can't
          // carry it away, though it may export any other.
          const workspaceId = "ws-ada-only";
          yield* runtimes.create({
            projectRoot: folder(),
            checkout: { kind: "main", path: folder() },
            deferOpen: true,
            readableBy: "ada",
            workspaceId: workspaceId as never,
          });
          const exported = (id: string) =>
            send(port, "POST", WORKSPACE_EXPORT_PATH, JSON.stringify({ workspaceId: id }), local);
          const refused = yield* exported(workspaceId);
          expect(refused.status, refused.body).toBe(404);
          expect(refused.body).toContain(NOT_READABLE);
          expect((yield* exported("ws-anyones")).body).not.toContain(NOT_READABLE);
        }),
      );
    },
  );

  test("leave a log's lines that name them out for anyone else", () => {
    const lines = [`turn ended {"threadId":"${PRIVATE}"}`, `turn ended {"threadId":"${OPEN}"}`];
    expect(logLinesFor({ subject: "mo" }, lines)).toEqual([lines[1]]);
    expect(logLinesFor({ subject: undefined }, lines)).toEqual([lines[1]]);
    expect(logLinesFor({ subject: "ada" }, lines)).toEqual(lines);
  });
});
