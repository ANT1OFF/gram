// The acceptance run of a headless control plane (`GRAM_HEADLESS=1`): the whole server, started
// headless with the hosted features on, and one machine that joins it over the host protocol as
// `gram-host` does (a join link, a confirmed key, a signed WebSocket dial) and serves the real
// host parts over the fake agent. Nothing runs in the server; an orchestrator and a worker run on
// the machine.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeWS from "@effect/platform-node/NodeWS";
import type { RemoteAppTools } from "@gram/agents";
import { captureLogs } from "@gram/agents/testing/logs";
import { afterAll, describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  GramRpcs,
  HOST_PROTOCOL_VERSION,
  HostId,
  PROFILE_START_PATH,
  RequestId,
  type Thread,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { eventually, hasGit, makeRepo } from "../git/test-repo.ts";
import { tokenCookieName } from "../http/auth.ts";
import { LaunchToken, ServerLayer, serverPort } from "../http/server.ts";
import {
  HttpServer,
  type Rpc,
  RpcClient,
  type RpcGroup,
  RpcSerialization,
  Socket,
} from "../platform/unstable.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentControl, makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { PROFILE_ORIGINS_DIR } from "../thread-profiles/repositories.ts";
import { hostStatusOf } from "./claude-sign-in.ts";
import { codexStatusOf } from "./codex-on-host.ts";
import { cloneWorktrees } from "./clone-worktrees.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { foldersOn, gatedSessions } from "./folders.ts";
import { gitOn } from "./git.ts";
import { HEADLESS_NEEDS_HOSTED, NO_MACHINE_JOINED, RUNS_NOTHING_HERE } from "./headless.ts";
import {
  generateHostKey,
  HOST_CONNECT_PATH,
  HOST_MCP_PATH,
  privateKeyFrom,
  signedConnectHeaders,
} from "./machine-keys.ts";
import { HOST_FEATURES, HOST_SERVES, type HostService, serveHost } from "./protocol.ts";
import { appToolsAt } from "./remote-app-tools.ts";
import { reposOn } from "./repos.ts";
import { sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { HOST_THREADS_DIR, threadPlacesOnHost } from "./thread-places.ts";

/** The address the machine joins and dials: the server's own, as it is reached over a tailnet. */
const ORIGIN = "https://device.tail123.ts.net:9443";
const HOST = "device.tail123.ts.net:9443";
/** The project's remote, which the machine clones; really a bare repository in a temp folder. */
const REMOTE = "https://git.example.test/acme/widgets.git";
const MACHINE_NAME = "build box";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-headless-")));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const raw = (
  port: number,
  options: { path: string; method?: string; headers?: Record<string, string>; body?: string },
) =>
  Effect.promise(
    () =>
      new Promise<RawResponse>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: options.path,
            method: options.method ?? "GET",
            headers: options.headers,
            agent: false,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            );
          },
        );
        req.on("error", reject);
        req.end(options.body);
      }),
  );

/** An RPC client of the app, as its window is: over `/ws` with the launch cookie. */
const appClient = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  port: number,
  cookie: string,
) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } } as never),
        ),
        Layer.provide(NodeWS.layerWebSocketConstructor),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(group).pipe(Effect.provideContext(protocol));
  });

/** The project as the control plane keeps it, and the bare repository its remote really is. */
const makeProject = (name = "control-plane") => {
  const root = makeRepo(join(dir, name));
  const bare = join(dir, `${name}-widgets.git`);
  execFileSync("git", ["clone", "--quiet", "--bare", root, bare]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", REMOTE]);
  return {
    root,
    /** What the machine's git runs with, so the remote's URL reaches the bare repository. */
    env: {
      GIT_ALLOW_PROTOCOL: "https:ssh:file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: REMOTE,
    },
  };
};

/**
 * A joined machine's host as `gram-host run` builds it, from the same parts, in folders of its
 * own: its sessions are the fake agent's, its app tools are reached at the server's `/host/mcp`.
 * `tools` collects each session's app tools as it opens, in order.
 */
const machineService = (
  hostId: HostId,
  port: number,
  env: Readonly<Record<string, string>>,
  tools: Array<RemoteAppTools>,
  name = "machine",
) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const agents = yield* AgentHosts;
    const home = join(dir, name);
    const repos = join(home, "repos");
    mkdirSync(repos, { recursive: true });
    const folders = foldersOn(proc, { home, hostHome: home, hostRepos: repos, agentHomes: [] });
    const sessions = yield* sessionsOnHost(agents.get, (endpoint) =>
      // The tailnet address is this test's loopback port, named as the machine names it.
      appToolsAt({
        ...endpoint,
        url: `http://127.0.0.1:${port}${HOST_MCP_PATH}`,
        headers: { ...endpoint.headers, host: HOST },
      }).pipe(Effect.tap((opened) => Effect.sync(() => void tools.push(opened)))),
    );
    const service: HostService = {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId,
        capabilities: HOST_SERVES,
        features: HOST_FEATURES,
        platform: process.platform,
        pid: process.pid,
      },
      files: filesOn(proc),
      folders,
      reads: fileReadsOn(proc),
      attachments: yield* attachmentsOnHost(join(home, "attachments")),
      threadPlaces: threadPlacesOnHost(proc, repos),
      repos: reposOn(proc, repos, env),
      worktrees: cloneWorktrees(proc, yield* Worktrees, env),
      git: gitOn(proc),
      terminals: yield* terminalsOnHost,
      sessions: gatedSessions(sessions, folders.gate),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
      status: hostStatusOf(
        Effect.succeed("signedIn" as const),
        // Its tools are found whatever this machine has installed.
        FOUND,
        agents.get("claude").pipe(
          Effect.flatMap((host) => host.listModels()),
          Effect.orElseSucceed(() => undefined),
        ),
        // Its Codex, as `gram-host run` reports it, over the fake.
        codexStatusOf(agents.get("codex"), FOUND),
      ),
    };
    return { service, repos };
  });

/** A login shell on the machine that finds every tool, whatever this machine has installed. */
const FOUND = () => Promise.resolve({ code: 0, stdout: "1.0.0\n" });

/** The server's machines as `/machines/list` gives them. */
const listMachines = (port: number, headers: Record<string, string>) =>
  Effect.map(
    raw(port, { path: "/machines/list", method: "POST", headers }),
    (
      response,
    ): ReadonlyArray<{
      id: string;
      name: string;
      onlineSince?: number;
      models?: unknown;
      codex?: { signIn: string; models?: ReadonlyArray<{ id: string }> };
    }> => JSON.parse(response.body).machines ?? [],
  );

/**
 * A machine joining the server at `port` as `gram-host join` does, the user confirming its key,
 * and its host dialling in as `gram-host run` does, over `agents`.
 */
const joinMachine = (
  port: number,
  local: Record<string, string>,
  project: { readonly env: Readonly<Record<string, string>> },
  agents: Context.Context<AgentHosts | FakeAgentControl>,
  name: string,
) =>
  Effect.gen(function* () {
    const link = yield* raw(port, { path: "/machines/join-link", method: "POST", headers: local });
    expect(link.status).toBe(200);
    const code = new URLSearchParams(new URL(JSON.parse(link.body).url).hash.slice(1)).get("code")!;
    const key = generateHostKey();
    const joined = yield* raw(port, {
      path: "/host/join",
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({
        code,
        name,
        platform: process.platform,
        publicKey: key.publicKey,
      }),
    });
    expect(joined.status).toBe(200);
    const hostId = HostId.make(JSON.parse(joined.body).hostId);
    const confirmed = yield* raw(port, {
      path: "/machines/confirm",
      method: "POST",
      headers: local,
      body: JSON.stringify({ id: hostId }),
    });
    expect(confirmed.status).toBe(200);
    const tools: Array<RemoteAppTools> = [];
    const machine = yield* machineService(hostId, port, project.env, tools, name).pipe(
      Effect.provideContext(agents),
      Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive))),
    );
    const socket = yield* Socket.makeWebSocket(`ws://127.0.0.1:${port}${HOST_CONNECT_PATH}`, {
      headers: {
        ...signedConnectHeaders(privateKeyFrom(key.privateKeyPem), ORIGIN, hostId, Date.now()),
        host: HOST,
      },
      openTimeout: "15 seconds",
    } as never).pipe(Effect.provide(NodeWS.layerWebSocketConstructor));
    yield* Effect.forkScoped(serveHost(socket, machine.service));
    return { hostId, machine, tools };
  });

/** The whole server, headless, over `agents` (which it must never ask for a session). */
const headlessServer = (
  agents: Context.Context<AgentHosts | FakeAgentControl>,
  config: { readonly dataDir: string; readonly embedding?: boolean },
) =>
  ServerLayer.pipe(
    Layer.provide(Layer.succeedContext(agents)),
    Layer.provide(TurnHooks.layerNoop),
    Layer.provide(gitPlatformTest()),
    Layer.provide(
      ServerConfig.layer({ ...TEST_CONFIG, ...config, remoteOrigin: ORIGIN, headless: true }),
    ),
    Layer.provideMerge(captureLogs({ printWarnings: false }).layer),
  );

describe.skipIf(!hasGit)("a headless control plane", () => {
  it.live("doesn't start with the hosted features off", () =>
    Effect.gen(function* () {
      const agents = yield* Layer.build(makeFakeAgentAdapter());
      // Neither set by the environment nor stored on: the default.
      const failed = yield* Layer.build(
        headlessServer(agents, { dataDir: join(dir, "data-off") }),
      ).pipe(Effect.flip);
      expect(failed).toMatchObject({ message: HEADLESS_NEEDS_HOSTED });
      // Turned off by the environment, over whatever was stored.
      const off = yield* Layer.build(
        headlessServer(agents, { dataDir: join(dir, "data-off"), embedding: false }),
      ).pipe(Effect.flip);
      expect(off).toMatchObject({ message: HEADLESS_NEEDS_HOSTED });
    }).pipe(Effect.scoped),
  );

  it.live(
    "starts nothing itself, and runs an orchestrator and a worker on a joined machine",
    () =>
      Effect.gen(function* () {
        const project = makeProject();
        // The agent the server was given, which a headless one never asks for a session.
        const serverAgents = yield* Layer.build(makeFakeAgentAdapter());
        const server = yield* Layer.build(
          headlessServer(serverAgents, { dataDir: join(dir, "data"), embedding: true }),
        );
        const { port, token } = yield* Effect.gen(function* () {
          return {
            port: serverPort(yield* HttpServer.HttpServer),
            token: (yield* LaunchToken).token,
          };
        }).pipe(Effect.provideContext(server));
        const booted = yield* raw(port, { path: `/?boot=${token}` });
        const cookie = booted.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
        expect(cookie.startsWith(`${tokenCookieName(port)}=`)).toBe(true);
        const local = {
          cookie,
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
        };
        const app = yield* appClient(GramRpcs, port, cookie);
        // The fake agent's models fill no tier of the recommended setup a headless server starts
        // with, so this one runs on the models it lists.
        yield* app["settings.set"]({ patch: { agents: { recommendedSetup: { enabled: false } } } });

        const added = yield* app["projects.add"]({ root: project.root });

        // Cloning by remote files the origin alone, reaching nothing (the remote's host doesn't
        // answer), for the machine a thread is placed on to clone with its own credentials.
        const filed = yield* app["projects.clone"]({ remote: REMOTE });
        expect(filed.name).toBe("widgets");
        expect(filed.root.startsWith(join(dir, "data", PROFILE_ORIGINS_DIR))).toBe(true);
        expect(
          execFileSync("git", ["-C", filed.root, "config", "--get", "remote.origin.url"], {
            encoding: "utf8",
          }).trim(),
        ).toBe(REMOTE);
        expect((yield* app["projects.clone"]({ remote: REMOTE })).id).toBe(filed.id);

        // With no machine joined, nothing can run: the server says so rather than run it here.
        const noMachine = yield* app["orchestrator.open"]({ projectId: added.id }).pipe(
          Effect.flip,
        );
        expect(noMachine).toMatchObject({ _tag: "AgentUnavailable", message: NO_MACHINE_JOINED });
        const noThread = yield* app["thread.create"]({
          projectRoot: project.root,
          checkout: { kind: "current" },
          input: { text: "hello" },
        }).pipe(Effect.flip);
        expect(noThread).toMatchObject({ _tag: "InvalidState", message: NO_MACHINE_JOINED });

        // A machine joins as `gram-host join` does, and the user confirms its key.
        const link = yield* raw(port, {
          path: "/machines/join-link",
          method: "POST",
          headers: local,
        });
        expect(link.status).toBe(200);
        const code = new URLSearchParams(new URL(JSON.parse(link.body).url).hash.slice(1)).get(
          "code",
        )!;
        const key = generateHostKey();
        const joined = yield* raw(port, {
          path: "/host/join",
          method: "POST",
          headers: { host: HOST, "content-type": "application/json" },
          body: JSON.stringify({
            code,
            name: MACHINE_NAME,
            platform: process.platform,
            publicKey: key.publicKey,
          }),
        });
        expect(joined.status).toBe(200);
        const hostId = HostId.make(JSON.parse(joined.body).hostId);
        const confirmed = yield* raw(port, {
          path: "/machines/confirm",
          method: "POST",
          headers: local,
          body: JSON.stringify({ id: hostId }),
        });
        expect(confirmed.status).toBe(200);

        // Joined but not running yet: still nowhere to run.
        const offline = yield* app["orchestrator.open"]({ projectId: added.id }).pipe(Effect.flip);
        expect(offline).toMatchObject({
          _tag: "AgentUnavailable",
          message: expect.stringContaining(`${MACHINE_NAME} is offline`),
        });

        // Its host starts and dials in, as `gram-host run` does.
        const machineAgents = yield* Layer.build(makeFakeAgentAdapter());
        const machineFake = yield* FakeAgentControl.pipe(Effect.provideContext(machineAgents));
        const tools: Array<RemoteAppTools> = [];
        const machine = yield* machineService(hostId, port, project.env, tools).pipe(
          Effect.provideContext(machineAgents),
          Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive))),
        );
        const socket = yield* Socket.makeWebSocket(`ws://127.0.0.1:${port}${HOST_CONNECT_PATH}`, {
          headers: {
            ...signedConnectHeaders(privateKeyFrom(key.privateKeyPem), ORIGIN, hostId, Date.now()),
            host: HOST,
          },
          openTimeout: "15 seconds",
        } as never).pipe(Effect.provide(NodeWS.layerWebSocketConstructor));
        yield* Effect.forkScoped(serveHost(socket, machine.service));
        const listed = yield* eventually(
          "the machine online",
          Effect.gen(function* () {
            const response = yield* raw(port, {
              path: "/machines/list",
              method: "POST",
              headers: local,
            });
            const machines: ReadonlyArray<{ id: string; onlineSince?: number; models?: unknown }> =
              JSON.parse(response.body).machines ?? [];
            const found = machines.find((each) => each.id === hostId);
            return found?.onlineSince !== undefined && found.models !== undefined
              ? found
              : undefined;
          }),
        );
        expect(listed).toMatchObject({ id: hostId, name: MACHINE_NAME });

        // What only this machine could run is refused, with or without a machine joined.
        const terminal = yield* app["terminal.open"]({
          cwd: project.root,
          cols: 80,
          rows: 24,
        }).pipe(Effect.flip);
        expect(terminal).toMatchObject({ message: RUNS_NOTHING_HERE });
        const here = yield* app["thread.create"]({
          projectRoot: project.root,
          checkout: { kind: "existingWorktree", path: project.root },
          input: { text: "hello" },
        }).pipe(Effect.flip);
        expect(here).toMatchObject({ _tag: "InvalidState", message: RUNS_NOTHING_HERE });

        // The orchestrator: placed on the machine, in the machine's own clone of the project.
        const orchestrator: Thread = yield* app["workspace.startTask"]({
          target: { projectId: added.id },
          input: { text: "Plan the work." },
        });
        expect(orchestrator.role).toBe("orchestrator");
        expect(orchestrator.checkout.hostId).toBe(hostId);
        expect(orchestrator.checkout.path.startsWith(machine.repos)).toBe(true);
        const orchestratorSession = yield* eventually(
          "the orchestrator's session on the machine",
          Effect.sync(() =>
            machineFake.sessions.find((session) => session.options.threadId === orchestrator.id),
          ),
        );
        expect(orchestratorSession.options.cwd).toBe(orchestrator.checkout.path);
        yield* eventually(
          "the orchestrator's first message",
          Effect.sync(() => orchestratorSession.sent.length > 0),
        );
        expect(existsSync(join(orchestrator.checkout.path, "tracked.txt"))).toBe(true);

        // It starts a worker through its app tools, which it reaches at the server from the
        // machine; the worker names no machine and lands on the same one, in a worktree there.
        const orchestratorTools = yield* eventually(
          "the orchestrator's app tools",
          Effect.sync(() => tools[0]),
        );
        expect(orchestratorTools.tools.map((tool) => tool.name)).toContain("spawn_worker");
        const spawned = yield* Effect.promise(() =>
          orchestratorTools.call("spawn_worker", {
            project: added.name,
            feature: "headless",
            title: "Worker on the machine",
            brief: "Synthetic work.",
          }),
        );
        expect(spawned.isError, JSON.stringify(spawned.content)).not.toBe(true);
        const workerSession = yield* eventually(
          "the worker's session on the machine",
          Effect.sync(() =>
            machineFake.sessions.find((session) => session.options.threadId !== orchestrator.id),
          ),
        );
        expect(workerSession.options.cwd.startsWith(machine.repos)).toBe(true);
        expect(workerSession.options.cwd).not.toBe(orchestrator.checkout.path);
        expect(existsSync(join(workerSession.options.cwd, "tracked.txt"))).toBe(true);

        // Nothing ran in the control plane: no session of its own agent, no worktree of its own.
        const serverFake = yield* FakeAgentControl.pipe(Effect.provideContext(serverAgents));
        expect(serverFake.sessions).toHaveLength(0);
        expect(machineFake.sessions).toHaveLength(2);
        expect(existsSync(join(project.root, ".worktrees"))).toBe(false);
        expect(
          existsSync(join(dir, "data", "worktrees"))
            ? readdirSync(join(dir, "data", "worktrees"))
            : [],
        ).toEqual([]);

        // A second machine joins and is confirmed, as another run's would be: started for other
        // work, it says no kind. A worker is never put there by naming it; "local", on a Gram that
        // runs nothing itself, is the orchestrator's own machine and never the default one.
        const otherCode = new URLSearchParams(
          new URL(
            JSON.parse(
              (yield* raw(port, { path: "/machines/join-link", method: "POST", headers: local }))
                .body,
            ).url,
          ).hash.slice(1),
        ).get("code")!;
        const otherKey = generateHostKey();
        const otherJoined = yield* raw(port, {
          path: "/host/join",
          method: "POST",
          headers: { host: HOST, "content-type": "application/json" },
          body: JSON.stringify({
            code: otherCode,
            name: "other run",
            platform: process.platform,
            publicKey: otherKey.publicKey,
          }),
        });
        const otherId = JSON.parse(otherJoined.body).hostId;
        expect(
          (yield* raw(port, {
            path: "/machines/confirm",
            method: "POST",
            headers: local,
            body: JSON.stringify({ id: otherId }),
          })).status,
        ).toBe(200);
        for (const otherName of ["other run", otherId]) {
          const named = yield* Effect.promise(() =>
            orchestratorTools.call("spawn_worker", {
              project: added.name,
              feature: "elsewhere",
              title: "On another run's machine",
              brief: "Synthetic work.",
              machine: otherName,
            }),
          );
          expect(named.isError).toBe(true);
          expect(JSON.stringify(named.content)).toContain(
            "A worker goes on its orchestrator's own machine",
          );
        }
        const localWorker = yield* Effect.promise(() =>
          orchestratorTools.call("spawn_worker", {
            project: added.name,
            feature: "here",
            title: "Here",
            brief: "Synthetic work.",
            machine: "local",
          }),
        );
        expect(localWorker.isError, JSON.stringify(localWorker.content)).not.toBe(true);
        const hereSession = yield* eventually(
          "the local worker's session on the orchestrator's machine",
          Effect.sync(() =>
            machineFake.sessions.length === 3 ? machineFake.sessions[2] : undefined,
          ),
        );
        expect(hereSession.options.cwd.startsWith(machine.repos)).toBe(true);
        expect(serverFake.sessions).toHaveLength(0);

        // A thread started from a profile names no machine either: its folder is made on the
        // machine, by the machine's host, with the profile's files in it, and it runs there.
        const fromProfile: Thread = yield* app["thread.createFromProfile"]({
          profile: {
            version: 1,
            name: "Release notes",
            agent: "claude",
            charter: "You write release notes.",
            files: [{ path: "AGENTS.md", content: "# House rules\n" }],
            skills: [{ name: "changelog", description: "Drafts a changelog.", body: "Draft." }],
            model: { model: "fake-model" },
            connectors: { server: { name: "workspace", url: "https://mcp.example.test/w" } },
            workplace: { kind: "scratch" },
            input: "Draft the notes.",
          },
        });
        expect(fromProfile.checkout).toMatchObject({
          kind: "main",
          hostId,
          path: join(machine.repos, HOST_THREADS_DIR, fromProfile.id),
        });
        expect(readFileSync(join(fromProfile.checkout.path, "AGENTS.md"), "utf8")).toBe(
          "# House rules\n",
        );
        expect(
          existsSync(join(fromProfile.checkout.path, ".claude/skills/changelog/SKILL.md")),
        ).toBe(true);
        const profileSession = yield* eventually(
          "the profile thread's session on the machine",
          Effect.sync(() =>
            machineFake.sessions.find((session) => session.options.threadId === fromProfile.id),
          ),
        );
        expect(profileSession.options.cwd).toBe(fromProfile.checkout.path);
        expect(profileSession.options.instructions).toContain("You write release notes.");
        expect(profileSession.options.mcpServer).toEqual({
          name: "workspace",
          url: "https://mcp.example.test/w",
        });
        expect(profileSession.options.mcpAllowlist).toEqual(["https://mcp.example.test/w"]);
        // Still nothing here: no session, and no folder for the thread in the data folder.
        expect(serverFake.sessions).toHaveLength(0);
        expect(existsSync(join(dir, "data", "profile-threads", fromProfile.id))).toBe(false);

        // The same over HTTP, as a fronting platform's own service asks, naming the machine.
        const threadId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
        const startBody = JSON.stringify({
          profile: {
            version: 1,
            agent: "claude",
            charter: "Named machine.",
            files: [{ path: "NOTES.md", content: "named\n" }],
            model: { model: "fake-model" },
            connectors: {},
            workplace: { kind: "scratch" },
          },
          threadId,
          hostId,
        });
        const overHttp = yield* raw(port, {
          path: PROFILE_START_PATH,
          method: "POST",
          headers: local,
          body: startBody,
        });
        expect(overHttp.status, overHttp.body).toBe(200);
        expect(JSON.parse(overHttp.body)).toEqual({ threadId, created: true });
        expect(
          readFileSync(join(machine.repos, HOST_THREADS_DIR, threadId, "NOTES.md"), "utf8"),
        ).toBe("named\n");
        const retried = yield* raw(port, {
          path: PROFILE_START_PATH,
          method: "POST",
          headers: local,
          body: startBody,
        });
        expect(JSON.parse(retried.body)).toEqual({ threadId, created: false });
        expect(serverFake.sessions).toHaveLength(0);
      }).pipe(Effect.scoped),
    60_000,
  );
  it.live(
    "runs a Codex thread on a joined machine: its models, start, approval, interrupt and resume",
    () =>
      Effect.gen(function* () {
        const project = makeProject("codex-plane");
        const serverAgents = yield* Layer.build(makeFakeAgentAdapter());
        const server = yield* Layer.build(
          headlessServer(serverAgents, { dataDir: join(dir, "codex-data"), embedding: true }),
        );
        const { port, token } = yield* Effect.gen(function* () {
          return {
            port: serverPort(yield* HttpServer.HttpServer),
            token: (yield* LaunchToken).token,
          };
        }).pipe(Effect.provideContext(server));
        const booted = yield* raw(port, { path: `/?boot=${token}` });
        const cookie = booted.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
        const local = {
          cookie,
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
        };
        const app = yield* appClient(GramRpcs, port, cookie);
        const added = yield* app["projects.add"]({ root: project.root });

        const machineAgents = yield* Layer.build(makeFakeAgentAdapter());
        const machineFake = yield* FakeAgentControl.pipe(Effect.provideContext(machineAgents));
        // Its Codex has Gram's native gated home ready, as a ChatGPT login there makes it.
        yield* machineFake.setNativeGateReady(true);
        const { hostId, tools } = yield* joinMachine(
          port,
          local,
          project,
          machineAgents,
          "codex box",
        );
        const listed = yield* eventually(
          "the machine's Codex status",
          Effect.map(listMachines(port, local), (machines) =>
            machines.find((each) => each.id === hostId && each.codex !== undefined),
          ),
        );
        // What the machine's own Codex said of itself: signed in, and what it lists.
        expect(listed.codex).toMatchObject({ signIn: "signedIn" });
        expect(listed.codex?.models?.map((model) => model.id)).toEqual(["fake-opus", "fake-haiku"]);

        // The picker's Codex models are the machine's, not this server's (which runs none).
        const models = yield* app["models.list"]({ agent: "codex" });
        expect(models.models.map((model) => model.id)).toEqual(["fake-opus", "fake-haiku"]);

        // Start: a Codex thread is placed on the machine and its session opens there.
        const thread: Thread = yield* app["thread.create"]({
          projectRoot: project.root,
          checkout: { kind: "current" },
          model: { agent: "codex", model: "fake-opus" },
          input: { text: "Start on Codex." },
        });
        expect(thread.checkout.hostId).toBe(hostId);
        const first = yield* eventually(
          "the Codex session on the machine",
          Effect.sync(() =>
            machineFake.sessions.find((session) => session.options.threadId === thread.id),
          ),
        );
        expect(first.options.model).toMatchObject({ agent: "codex", model: "fake-opus" });
        expect(first.options.cwd).toBe(thread.checkout.path);
        yield* eventually(
          "the first message",
          Effect.sync(() => first.sent.length > 0),
        );
        // The session lives in a Codex home of the machine's; the thread keeps which.
        yield* first.emit({
          type: "identity",
          agentSessionId: first.agentSessionId,
          model: "fake-opus",
          tools: [],
          commands: [],
          codexHome: "owned",
        });

        // Approval: the machine's agent asks, the answer reaches it there.
        const requestId = RequestId.make(randomUUID());
        yield* first.emit(
          {
            type: "request",
            request: {
              kind: "approval",
              id: requestId,
              toolName: "Bash",
              displayName: "Bash",
              input: { command: "echo synthetic", description: "A synthetic command" },
              suggestions: [],
            },
          },
          { type: "status", status: "awaitingApproval" },
        );
        yield* eventually(
          "the answer taken",
          app["thread.respond"]({
            threadId: thread.id,
            requestId,
            answer: { kind: "approval", decision: "allow", scope: "once" },
          }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        );
        yield* eventually(
          "the answer on the machine",
          Effect.sync(() => first.responses.some((response) => response.requestId === requestId)),
        );
        expect(
          first.responses.find((response) => response.requestId === requestId)?.answer,
        ).toEqual({ kind: "approval", decision: "allow", scope: "once" });

        // Interrupt: the turn stops on the machine.
        yield* first.emit({ type: "status", status: "running" });
        yield* app["thread.interrupt"]({ threadId: thread.id });
        yield* eventually(
          "the interrupt on the machine",
          Effect.sync(() => first.interrupts > 0),
        );

        // Resume: a restart opens the same conversation on the machine again, in the same home,
        // the wait for the previous app-server going with it.
        yield* app["thread.restartSession"]({ threadId: thread.id });
        const resumed = yield* eventually(
          "the resumed session on the machine",
          Effect.sync(() =>
            machineFake.sessions.find(
              (session) => session.options.threadId === thread.id && session !== first,
            ),
          ),
        );
        expect(first.closed).toBe(true);
        expect(resumed.options.resumeId).toBe(first.agentSessionId);
        expect(resumed.options.codexHome).toBe("owned");
        expect(resumed.options.waitForPreviousSession).toBeDefined();
        expect(resumed.options.model).toMatchObject({ agent: "codex" });

        // A Codex worker under a workspace that asks before what can't be undone: its
        // orchestrator spawns it, it goes on the machine, and the machine's Codex holds the gate.
        const toolsBefore = tools.length;
        const orchestrator: Thread = yield* app["workspace.startTask"]({
          target: { projectId: added.id },
          input: { text: "Plan the work." },
        });
        expect(orchestrator.checkout.hostId).toBe(hostId);
        yield* app["orchestrator.setCharter"]({
          workspaceId: orchestrator.workspaceId!,
          charter: {
            ...DEFAULT_CHARTER,
            autonomy: "publish",
            workerModels: [{ agent: "codex", model: "fake-opus" }],
          },
        });
        // A new charter may reopen the orchestrator's session: its tools are its newest one's.
        const spawned = yield* eventually(
          "the orchestrator's spawn",
          Effect.tryPromise(() => {
            const current = tools.length > toolsBefore ? tools.at(-1) : undefined;
            return current === undefined
              ? Promise.resolve(undefined)
              : current.call("spawn_worker", {
                  project: added.name,
                  feature: "codex-worker",
                  title: "Codex worker on the machine",
                  brief: "Synthetic work.",
                });
          }).pipe(Effect.orElseSucceed(() => undefined)),
        );
        expect(spawned.isError, JSON.stringify(spawned.content)).not.toBe(true);
        const worker = yield* eventually(
          "the Codex worker's session on the machine",
          Effect.sync(() =>
            machineFake.sessions.find(
              (session) =>
                session.options.audience === "worker" && session.options.model?.agent === "codex",
            ),
          ),
        );
        expect(worker.options.model).toMatchObject({ agent: "codex", model: "fake-opus" });
        expect(worker.options.outwardGate).toBeDefined();

        // Nothing ran here.
        const serverFake = yield* FakeAgentControl.pipe(Effect.provideContext(serverAgents));
        expect(serverFake.sessions).toHaveLength(0);
      }).pipe(Effect.scoped),
    60_000,
  );
});
