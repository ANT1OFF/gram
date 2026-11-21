import type {
  AgentConnectors,
  AgentMcpConfig,
  ConnectorSignInStart,
  ConnectorStatus,
} from "@gram/agents";
import {
  awaitsSignIn,
  ConnectorRpcs,
  effectiveCheckout,
  InvalidState,
  restartOnMcpChangeOn,
  MCP_SERVER_NAME_PATTERN,
  MCP_TARGET_LABEL,
  mcpScopeFor,
  mcpTargetOf,
  MASKED_VALUE,
  presentableUrl,
  type AddConnectorPayload,
  type AgentUnavailable,
  type AgentConfiguredServers,
  type ClaudeAiSource,
  type ConfiguredServer,
  type ConnectorConfigResult,
  type ConnectorList,
  type ConnectorSignIn,
  type ConnectorSignInPayload,
  type McpScope,
  type SeenConnector,
  type McpTarget,
  type RemoveConnectorPayload,
  type SignInKnowledge,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { samePath } from "@gram/git";
import { homedir } from "node:os";
import { McpCatalogue } from "../../connectors/catalogue.ts";
import { ClaudeAiSeen } from "../../connectors/claude-ai-seen.ts";
import {
  addJsonArgs,
  connectorSignInPage,
  loginFailure,
  McpCli,
  type McpCliShape,
  redact,
  removeArgs,
  secretsOf,
} from "../../connectors/mcp-cli.ts";
import { isLocalApp } from "../../http/local-app.ts";
import { makeKeyedLock } from "../../git/keyed-lock.ts";
import { redactText } from "../../logging/redact.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { AgentHosts } from "../../runtime/agent-hosts.ts";
import { ThreadRuntimes, type McpConfigChange } from "../../runtime/thread-runtimes.ts";
import { logDefects, type Handlers } from "./common.ts";

const detailOf = (text: string, secrets: ReadonlyArray<string>) =>
  redact(text.trim(), secrets).split("\n").slice(0, 3).join(" ");

const placement = (target: McpTarget, folder: string, scope: McpScope, name: string) => ({
  cwd: folder,
  scope: mcpScopeFor(target, scope),
  name,
});

const TARGETS: ReadonlyArray<McpTarget> = ["claude", "codex"];

const changeOf = (
  target: McpTarget,
  folder: string,
  scope: McpScope | undefined,
): McpConfigChange =>
  scope === undefined || mcpScopeFor(target, scope) === "user"
    ? { agent: target }
    : { agent: target, folder };

const CLAUDE_SIGN_IN =
  "Claude Code signs in through a Claude thread running where this server is configured: start one there, or run claude in a terminal and open /mcp.";

const CONNECTOR_SIGN_IN_WAIT_MS = 5 * 60_000;
export const CONNECTOR_RECONNECT_EVERY_MS = 5_000;

const hostedRow = (name: string): ConfiguredServer => ({
  name,
  transport: "other",
  scope: "claudeai",
  carriesValues: false,
});

const liveRow = ({ name, url, tools, claudeAi }: ConnectorStatus): ConfiguredServer => ({
  ...hostedRow(name),
  ...(url === undefined ? {} : { url }),
  ...(tools === undefined ? {} : { tools }),
  ...(claudeAi === undefined ? {} : { claudeAi }),
});

const seenRow = ({ name, status, seenAt, url, id, tools }: SeenConnector): ConfiguredServer => ({
  ...hostedRow(name),
  ...(url === undefined ? {} : { url }),
  ...(tools === undefined ? {} : { tools }),
  ...(id === undefined ? {} : { claudeAi: { id } }),
  seenAt: new Date(seenAt).toISOString(),
  ...(status === "connected"
    ? { signedIn: true }
    : status === "needs-auth"
      ? { signedIn: false }
      : {}),
});

type LoginOutcome =
  | { readonly state: "waiting" | "signedIn" }
  | { readonly state: "failed"; readonly message: string };

const loginFolder = (scope: string | undefined, folder: string | undefined) =>
  scope === undefined || scope === "user" || folder === undefined ? homedir() : folder;

const loginKey = (folder: string, name: string, url: string | undefined) =>
  [folder, name, url ?? ""].join("\u0000");

const loginKeyName = (key: string) => key.split("\u0000")[1];

interface AgentList {
  readonly servers: ReadonlyArray<ConfiguredServer>;
  readonly claudeAiFrom?: ClaudeAiSource;
  readonly claudeAiUnavailable?: string;
}

interface LiveClaude {
  readonly threadId: ThreadId;
  readonly folder: string;
  readonly connectors: AgentConnectors;
  readonly status: ReadonlyArray<ConnectorStatus>;
}

const PER_FOLDER: ReadonlySet<string> = new Set<McpScope>(["local", "project"]);

const sessionFor = (
  sessions: ReadonlyArray<LiveClaude>,
  name: string,
  scope: string | undefined,
  folder: string | undefined,
) =>
  sessions.find(
    (session) =>
      session.status.some((c) => c.name === name && (scope === undefined || c.scope === scope)) &&
      (scope === undefined || !PER_FOLDER.has(scope) || session.folder === folder),
  );

const toSignIn = (started: ConnectorSignInStart): ConnectorSignIn =>
  started === "started"
    ? { kind: "started" }
    : { kind: "open", authorizationUrl: started.authorizationUrl };

const SECRET_FLAG = /^--?[\w-]*(?:token|secret|password|passphrase|api[-_]?key|credential)[\w-]*$/i;

/**
 * A server's address as the UI may see it. The readers already dropped header and env values; what
 * is left can still carry a credential in the URL or in a command's arguments, so those are masked
 * here, before the RPC boundary. Anything masked counts as a value the server carries: a copy made
 * from what the UI holds would be missing it.
 */
export const presentable = (server: ConfiguredServer): ConfiguredServer => {
  const url = server.url === undefined ? undefined : presentableUrl(server.url);
  const command = server.command === undefined ? undefined : redactText(server.command);
  const args = server.args?.map((arg, i, all) =>
    i > 0 && SECRET_FLAG.test(all[i - 1]!) ? MASKED_VALUE : redactText(arg),
  );
  const masked =
    url !== server.url ||
    command !== server.command ||
    (args ?? []).some((arg, i) => arg !== server.args![i]);
  return {
    ...server,
    ...(url === undefined ? {} : { url }),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    carriesValues: server.carriesValues || masked,
  };
};

/**
 * `connectors.*`: the MCP connectors of a thread's live agent session, and adding or removing servers
 * in each agent's own config. Servers, sign-ins and tokens stay the agents': Claude Code's through
 * its CLI, Codex's through their hosts. Nothing here starts a session.
 */
/** How long one running Claude thread gets to say how its MCP servers are. */
export const LIVE_STATUS_TIMEOUT_MS = 2_000;

const LIVE_RELOAD_TIMEOUT_MS = 10_000;

const reloadLive = (sessions: ReadonlyArray<LiveClaude>, name: string) =>
  Effect.forEach(
    sessions,
    ({ threadId, connectors }) =>
      connectors.reconnect(name).pipe(
        Effect.ignore,
        Effect.andThen(connectors.status),
        Effect.timeoutOption(LIVE_RELOAD_TIMEOUT_MS),
        Effect.map((status) =>
          Option.isSome(status) && status.value.some((c) => c.name === name) ? [threadId] : [],
        ),
        Effect.orElseSucceed((): ReadonlyArray<ThreadId> => []),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((reloaded) => reloaded.flat()));

/** How long one agent gets to list its MCP servers before the list says it didn't answer. */
export const AGENT_LIST_TIMEOUT_MS = 10_000;

/**
 * How old the last read of the agents' configs may be before a reader's request starts another
 * behind its answer. The reader never waits for it.
 */
export const CONFIGURED_REFRESH_MS = 5_000;

/**
 * The connectors' handlers and the writes under them. Every write of a server's entry, whether the
 * RPCs' or an approved `mcp_server_propose`'s, holds that name's lock (`writes.withName`), so a
 * check of what an agent has under the name and the write after it can't be split by another.
 */
export const makeConnectorConfigs = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const store = yield* ThreadStore;
  const hosts = yield* AgentHosts;
  const mcp = yield* McpCli;
  const catalogue = yield* McpCatalogue;
  const seenConnectors = yield* ClaudeAiSeen;
  const configuredCache = new Map<
    string,
    { readonly agents: ReadonlyArray<AgentConfiguredServers>; readonly at: number }
  >();
  const configuredRefreshes = yield* FiberMap.make<string>();
  const nameLock = makeKeyedLock<string>();
  const withName = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
    nameLock.withLock(name.toLowerCase(), effect);
  let generation = 0;
  const logins = yield* FiberMap.make<string>();
  const lists = yield* FiberMap.make<string, AgentList, string>();
  const loginOutcomes = new Map<string, LoginOutcome>();
  const forgetLogins = (name: string) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...loginOutcomes.keys()].filter((key) => loginKeyName(key) === name),
        (key) =>
          FiberMap.remove(logins, key).pipe(
            Effect.andThen(Effect.sync(() => loginOutcomes.delete(key))),
          ),
        { discard: true },
      ),
    );

  for (const target of ["codex"] as const) {
    const signedIn = yield* hosts.get(target).pipe(
      Effect.map((host) => host.mcpConfig?.signedIn),
      Effect.orElseSucceed(() => undefined),
    );
    if (signedIn === undefined) continue;
    yield* Effect.forkScoped(
      Stream.runForEach(signedIn, () => runtimes.mcpConfigChanged({ agent: target })),
    );
  }

  const liveConnectors = (threadId: ThreadId) =>
    runtimes.session(threadId).pipe(
      Effect.map((session): AgentConnectors | "unsupported" => session.connectors ?? "unsupported"),
      Effect.catchTag("InvalidState", () => Effect.succeed("noSession" as const)),
    );

  const control = <A>(
    threadId: ThreadId,
    run: (connectors: AgentConnectors) => Effect.Effect<A, AgentUnavailable | InvalidState>,
  ) =>
    liveConnectors(threadId).pipe(
      Effect.flatMap((connectors): Effect.Effect<A, AgentUnavailable | InvalidState> =>
        connectors === "noSession"
          ? Effect.fail(
              new InvalidState({ message: "Start the thread to change its connectors.", threadId }),
            )
          : connectors === "unsupported"
            ? Effect.fail(
                new InvalidState({
                  message: "This agent doesn't report its connectors.",
                  threadId,
                }),
              )
            : run(connectors),
      ),
    );

  const placeFor = (
    threadId: ThreadId | undefined,
    cwd: string | undefined,
    scope: McpScope | undefined,
  ) =>
    threadId !== undefined
      ? store.getThread(threadId).pipe(
          Effect.map((thread) => ({
            folder: effectiveCheckout(thread).path,
            agent: mcpTargetOf(thread.model.agent) ?? ("claude" as const),
          })),
        )
      : cwd !== undefined && cwd.trim() !== ""
        ? Effect.succeed({ folder: cwd, agent: "claude" as const })
        : scope === "user"
          ? Effect.succeed({ folder: homedir(), agent: "claude" as const })
          : Effect.fail(
              new InvalidState({
                message: "Pick a thread or a folder to configure the server for.",
              }),
            );

  const viaClaude = (args: ReadonlyArray<string>, folder: string, secrets: ReadonlyArray<string>) =>
    mcp.run(args, folder).pipe(
      Effect.mapError((error) => error.message),
      Effect.flatMap((out) =>
        out.status === 0
          ? Effect.void
          : Effect.fail(detailOf(out.stderr.trim() || out.stdout.trim(), secrets)),
      ),
    );

  const viaHost = (
    target: Exclude<McpTarget, "claude">,
    secrets: ReadonlyArray<string>,
    run: (config: AgentMcpConfig) => Effect.Effect<void, AgentUnavailable>,
  ) =>
    hosts.get(target).pipe(
      Effect.flatMap((host) =>
        host.mcpConfig === undefined
          ? Effect.fail(`Gram can't write ${MCP_TARGET_LABEL[target]}'s config.`)
          : run(host.mcpConfig).pipe(Effect.mapError((error) => error.message)),
      ),
      Effect.mapError((error) =>
        detailOf(typeof error === "string" ? error : error.message, secrets),
      ),
    );

  const configure = (
    request: AddConnectorPayload | RemoveConnectorPayload,
    verb: "add" | "remove",
    targets: ReadonlyArray<McpTarget> | undefined,
    write: (target: McpTarget, folder: string) => Effect.Effect<void, string>,
  ) =>
    Effect.gen(function* () {
      const { threadId, cwd, name } = request;
      if (!MCP_SERVER_NAME_PATTERN.test(name)) {
        return yield* new InvalidState({
          message: "Server names use letters, digits, dashes or underscores (up to 64).",
        });
      }
      const { folder, agent } = yield* placeFor(threadId, cwd, request.scope);
      const done: Array<McpTarget> = [];
      for (const target of new Set(targets ?? [agent])) {
        yield* write(target, folder).pipe(
          Effect.mapError((detail) => {
            const several = (targets?.length ?? 1) > 1;
            const where = several
              ? ` ${verb === "add" ? "to" : "from"} ${MCP_TARGET_LABEL[target]}`
              : "";
            const before =
              done.length === 0
                ? ""
                : ` (${done.map((t) => MCP_TARGET_LABEL[t]).join(", ")} already ${verb === "add" ? "has" : "lost"} it)`;
            return new InvalidState({
              message: `Couldn't ${verb} ${name}${where}${detail === "" ? "" : `: ${detail}`}${before}`,
              ...(threadId === undefined ? {} : { threadId }),
            });
          }),
        );
        done.push(target);
      }
      generation += 1;
      configuredCache.clear();
      const live: Array<ThreadId> = [];
      const marked = yield* Effect.forEach(done, (target) =>
        Effect.gen(function* () {
          const change = changeOf(target, folder, request.scope);
          const except =
            target === "claude" && verb === "add" ? yield* reloadClaude(name, change) : [];
          live.push(...except);
          return yield* runtimes.mcpConfigChanged({ ...change, except });
        }),
      );
      const session =
        threadId === undefined
          ? ("noSession" as const)
          : marked.some((threads) => threads.includes(threadId))
            ? ("reopening" as const)
            : live.includes(threadId)
              ? ("applied" as const)
              : yield* runtimes.reloadSession(threadId);
      return { name, session } satisfies ConnectorConfigResult;
    });

  const liveClaudes = (folder: string | undefined) =>
    Effect.gen(function* () {
      const live = (yield* runtimes.snapshot)
        .filter(({ thread, status }) => thread.model.agent === "claude" && status !== "cold")
        .toSorted(
          (a, b) =>
            Number(effectiveCheckout(b.thread).path === folder) -
            Number(effectiveCheckout(a.thread).path === folder),
        );
      const answers = yield* Effect.forEach(
        live,
        ({ thread }) =>
          Effect.gen(function* () {
            const connectors = yield* liveConnectors(thread.id).pipe(
              Effect.catchTag("ThreadNotFound", () => Effect.succeed("noSession" as const)),
            );
            if (typeof connectors === "string") return undefined;
            const status = yield* connectors.status.pipe(
              Effect.timeoutOption(LIVE_STATUS_TIMEOUT_MS),
              Effect.orElseSucceed(() => Option.none()),
            );
            if (Option.isNone(status)) return undefined;
            const listed = status.value.filter((c) => c.builtIn !== true);
            const session: LiveClaude = {
              threadId: thread.id,
              folder: effectiveCheckout(thread).path,
              connectors,
              status: listed,
            };
            return session;
          }),
        { concurrency: "unbounded" },
      );
      return answers.filter((session) => session !== undefined);
    });

  const reloadClaude = (name: string, change: McpConfigChange) =>
    Effect.gen(function* () {
      if (!restartOnMcpChangeOn(yield* store.getSettings)) return [];
      const reached = (yield* liveClaudes(change.folder)).filter(
        ({ folder }) => change.folder === undefined || samePath(folder, change.folder),
      );
      const confined = reached.filter(
        ({ connectors }) =>
          connectors.allowlist !== undefined && !connectors.allowlist.includes(name),
      );
      const reloaded = yield* reloadLive(
        reached.filter((session) => !confined.includes(session)),
        name,
      );
      return [...confined.map((session) => session.threadId), ...reloaded];
    });

  const startLogin = (
    login: NonNullable<McpCliShape["login"]>,
    name: string,
    folder: string,
    url: string | undefined,
  ): Effect.Effect<ConnectorSignInStart> => {
    const key = loginKey(folder, name, url);
    const reconnectWaiting = liveClaudes(folder).pipe(
      Effect.flatMap((sessions) => {
        const waiting = sessions.filter(({ status }) =>
          status.some((c) => c.name === name && c.status === "needs-auth"),
        );
        return reloadLive(waiting, name).pipe(
          Effect.map((reloaded) =>
            waiting.map((s) => s.threadId).filter((id) => !reloaded.includes(id)),
          ),
        );
      }),
      Effect.flatMap((threads) =>
        threads.length === 0
          ? Effect.void
          : runtimes.mcpConfigChanged({ agent: "claude", threads }).pipe(Effect.asVoid),
      ),
    );
    const run = login(name, folder).pipe(
      Effect.flatMap((out) =>
        out.status === 0 ? Effect.void : Effect.fail({ message: loginFailure(out) }),
      ),
      Effect.matchEffect({
        onSuccess: () =>
          Effect.sync(() => loginOutcomes.set(key, { state: "signedIn" })).pipe(
            Effect.andThen(reconnectWaiting),
          ),
        onFailure: ({ message }) =>
          Effect.sync(() => loginOutcomes.set(key, { state: "failed", message })).pipe(
            Effect.andThen(Effect.logWarning("claude mcp login didn't finish", { name, message })),
          ),
      }),
    );
    return Effect.sync(() => loginOutcomes.set(key, { state: "waiting" })).pipe(
      Effect.andThen(FiberMap.run(logins, key, run)),
      Effect.as("started" as const),
    );
  };

  const watchConnector = (name: string) =>
    Effect.gen(function* () {
      const until = (yield* Clock.currentTimeMillis) + CONNECTOR_SIGN_IN_WAIT_MS;
      while ((yield* Clock.currentTimeMillis) < until) {
        yield* Effect.sleep(CONNECTOR_RECONNECT_EVERY_MS);
        const sessions = yield* liveClaudes(undefined);
        const listed = sessions.flatMap(({ status }) => status.filter((c) => c.name === name));
        if (listed.length > 0 && listed.every((c) => !awaitsSignIn(c) && c.status !== "pending")) {
          return;
        }
        yield* reloadLive(
          sessions.filter(({ status }) => status.some((c) => c.name === name && awaitsSignIn(c))),
          name,
        );
      }
    });

  const connectorSignIn = (name: string): Effect.Effect<ConnectorSignIn, InvalidState> => {
    const { connectorLogin } = mcp;
    if (connectorLogin === undefined) {
      return Effect.fail(new InvalidState({ message: CLAUDE_SIGN_IN }));
    }
    return connectorLogin(name).pipe(
      Effect.flatMap((out) => {
        const page = out.status === 0 ? connectorSignInPage(out) : undefined;
        return page === undefined
          ? Effect.fail(
              new InvalidState({
                message: `Couldn't start signing in to ${name}: ${loginFailure(out)}`,
              }),
            )
          : Effect.succeed(page);
      }),
      Effect.tap(() => FiberMap.run(logins, `claudeai\u0000${name}`, watchConnector(name))),
      Effect.map((authorizationUrl) => ({ kind: "onClaudeAi" as const, authorizationUrl })),
    );
  };

  const claudeSignIn = (name: string, scope: string | undefined, folder: string | undefined) =>
    liveClaudes(folder).pipe(
      Effect.flatMap(
        (sessions): Effect.Effect<ConnectorSignIn, InvalidState | AgentUnavailable> => {
          const live = sessionFor(sessions, name, scope, folder);
          if (live?.connectors.authenticate !== undefined)
            return live.connectors.authenticate(name).pipe(Effect.map(toSignIn));
          if (scope === "claudeai") return connectorSignIn(name);
          const { login } = mcp;
          if (login === undefined) {
            return Effect.fail(
              new InvalidState({
                message: CLAUDE_SIGN_IN,
              }),
            );
          }
          return mcp.configured(folder).pipe(
            Effect.orElseSucceed((): ReadonlyArray<ConfiguredServer> => []),
            Effect.map(
              (servers) =>
                servers.find((s) => s.name === name && (scope === undefined || s.scope === scope))
                  ?.url,
            ),
            Effect.flatMap((url) => startLogin(login, name, loginFolder(scope, folder), url)),
            Effect.map(toSignIn),
          );
        },
      ),
    );

  const threadlessSignIn = (
    request: ConnectorSignInPayload,
  ): Effect.Effect<ConnectorSignIn, InvalidState | AgentUnavailable> => {
    const { target, name, cwd, scope } = request;
    return target === "claude"
      ? claudeSignIn(name, scope, cwd === undefined || cwd.trim() === "" ? undefined : cwd)
      : hosts.get(target).pipe(
          Effect.flatMap((host): Effect.Effect<ConnectorSignIn, InvalidState | AgentUnavailable> =>
            host.mcpConfig === undefined
              ? Effect.fail(
                  new InvalidState({
                    message: `Gram can't reach ${MCP_TARGET_LABEL[target]}'s sign-in.`,
                  }),
                )
              : host.mcpConfig.signIn(name, cwd).pipe(Effect.map(toSignIn)),
          ),
        );
  };

  const hostedRows = (sessions: ReadonlyArray<LiveClaude>) =>
    Effect.gen(function* () {
      const ever = new Set(yield* mcp.everConnected ?? Effect.succeed([]));
      const live = sessions.find(({ status }) => status.some((c) => c.scope === "claudeai"));
      const seen = live === undefined ? yield* seenConnectors.read : [];
      const [from, rows]: readonly [ClaudeAiSource, ReadonlyArray<ConfiguredServer>] =
        live !== undefined
          ? ["thread", live.status.filter((c) => c.scope === "claudeai").map(liveRow)]
          : seen.length > 0
            ? ["lastSeen", seen.map(seenRow)]
            : ["history", [...ever].map(hostedRow)];
      return {
        from,
        rows: rows.map((row) => (ever.has(row.name) ? { ...row, everConnected: true } : row)),
      };
    });

  const claudeConfigured = (folder: string | undefined): Effect.Effect<AgentList, InvalidState> =>
    Effect.gen(function* () {
      const [servers, sessions] = yield* Effect.all([mcp.configured(folder), liveClaudes(folder)]);
      const signInOf = ({ name, scope, transport, url }: ConfiguredServer) => {
        if (transport === "stdio") return {};
        const session = sessionFor(sessions, name, scope, folder);
        const status = session?.status.find((c) => c.name === name)?.status;
        if (status === "connected") return { signedIn: true };
        const outcome = loginOutcomes.get(loginKey(loginFolder(scope, folder), name, url));
        const failed = outcome?.state === "failed" ? { signInFailed: outcome.message } : {};
        if (status === "needs-auth") return { signedIn: false, ...failed };
        return outcome?.state === "signedIn" ? { signedIn: true } : failed;
      };
      const known = new Set(servers.map((server) => server.name));
      const hosted = yield* hostedRows(sessions);
      const rows = hosted.rows.filter((row) => !known.has(row.name));
      const unavailable = sessions.every((session) => session.connectors.claudeAiUnavailable)
        ? sessions[0]?.connectors.claudeAiUnavailable
        : undefined;
      return {
        servers: [...servers, ...rows].map((server) => ({ ...server, ...signInOf(server) })),
        ...(rows.length === 0 ? {} : { claudeAiFrom: hosted.from }),
        ...(unavailable === undefined ? {} : { claudeAiUnavailable: unavailable }),
      };
    });

  const configuredFor = (
    target: McpTarget,
    folder: string | undefined,
    checkSignIn: boolean,
  ): Effect.Effect<AgentConfiguredServers> => {
    const signIn: SignInKnowledge =
      target === "claude" ? "liveOnly" : target === "codex" ? "onRequest" : "reported";
    const read: Effect.Effect<AgentList, string> =
      target === "claude"
        ? claudeConfigured(folder).pipe(Effect.mapError((error) => error.message))
        : hosts.get(target).pipe(
            Effect.flatMap((host) =>
              host.mcpConfig === undefined
                ? Effect.succeed([])
                : host.mcpConfig.list({ cwd: folder, checkSignIn }),
            ),
            Effect.map((servers) => ({ servers })),
            Effect.mapError((error) => redactText(detailOf(error.message, []))),
          );
    const threadless = target === "claude" ? { threadlessSignIn: mcp.login !== undefined } : {};
    return Effect.gen(function* () {
      const since = generation;
      const key = `${since}|${target}|${folder ?? ""}|${checkSignIn}`;
      const current = FiberMap.getUnsafe(lists, key);
      const running = Option.isSome(current)
        ? current.value
        : yield* FiberMap.run(lists, key, read, { onlyIfMissing: true }).pipe(
            Effect.map((fiber) => Option.getOrElse(FiberMap.getUnsafe(lists, key), () => fiber)),
          );
      const { servers, ...more } = yield* Fiber.join(running).pipe(
        Effect.timeoutOrElse({
          duration: AGENT_LIST_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(`${MCP_TARGET_LABEL[target]} didn't answer in time; refresh to ask again.`),
        }),
      );
      const shown = servers.map(presentable);
      return { target, signIn, ...threadless, ...more, servers: shown };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ target, signIn, ...threadless, servers: [], error }),
      ),
    );
  };

  const readConfigured = (folder: string | undefined, checkSignIn: ReadonlyArray<McpTarget>) =>
    Effect.gen(function* () {
      const since = generation;
      const agents = yield* Effect.forEach(
        TARGETS,
        (target) => configuredFor(target, folder, checkSignIn.includes(target)),
        { concurrency: "unbounded" },
      );
      if (checkSignIn.length === 0 && since === generation) {
        configuredCache.set(folder ?? "", { agents, at: yield* Clock.currentTimeMillis });
      }
      return agents;
    });

  const configuredAgents = (folder: string | undefined, fresh: boolean) =>
    Effect.gen(function* () {
      const key = folder ?? "";
      const cached = configuredCache.get(key);
      if (fresh || cached === undefined) {
        return { agents: yield* readConfigured(folder, []), refreshing: false };
      }
      const running = `${generation}|${key}`;
      if ((yield* Clock.currentTimeMillis) - cached.at > CONFIGURED_REFRESH_MS) {
        yield* FiberMap.run(configuredRefreshes, running, readConfigured(folder, []), {
          onlyIfMissing: true,
        });
      }
      const refreshing = yield* FiberMap.has(configuredRefreshes, running);
      return { agents: (configuredCache.get(key) ?? cached).agents, refreshing };
    });

  const addServer = (request: AddConnectorPayload) =>
    configure(request, "add", request.targets, (target, folder) =>
      target === "claude"
        ? viaClaude(
            addJsonArgs(request.name, request.scope, request.config),
            folder,
            secretsOf(request.config),
          ).pipe(Effect.ensuring(forgetLogins(request.name)))
        : viaHost(target, secretsOf(request.config), (config) =>
            config.add(placement(target, folder, request.scope, request.name), request.config),
          ),
    );

  const removeServer = (request: RemoveConnectorPayload) =>
    configure(
      request,
      "remove",
      request.target === undefined ? undefined : [request.target],
      (target, folder) =>
        target === "claude"
          ? viaClaude(removeArgs(request.name, request.scope), folder, []).pipe(
              Effect.ensuring(forgetLogins(request.name)),
            )
          : viaHost(target, [], (config) =>
              config.remove(placement(target, folder, request.scope ?? "user", request.name)),
            ),
    );

  const handlers = {
    "connectors.configured": ({ cwd, checkSignIn, fresh }) =>
      Effect.gen(function* () {
        const folder = cwd === undefined || cwd.trim() === "" ? undefined : cwd;
        const { agents, refreshing } =
          checkSignIn !== undefined && checkSignIn.length > 0
            ? { agents: yield* readConfigured(folder, checkSignIn), refreshing: false }
            : yield* configuredAgents(folder, fresh === true);
        return {
          agents,
          ...(refreshing ? { refreshing } : {}),
        };
      }),
    "connectors.catalogue": () => catalogue.read,
    "connectors.signIn": threadlessSignIn,
    "connectors.list": ({ threadId }) =>
      liveConnectors(threadId).pipe(
        Effect.flatMap((connectors): Effect.Effect<ConnectorList, AgentUnavailable> =>
          typeof connectors === "string"
            ? Effect.succeed({ live: false, reason: connectors })
            : connectors.status.pipe(
                Effect.map((all) => ({
                  live: true as const,
                  connectors: all,
                  ...(connectors.claudeAiUnavailable === undefined
                    ? {}
                    : { claudeAiUnavailable: connectors.claudeAiUnavailable }),
                })),
              ),
        ),
      ),
    "connectors.reconnect": ({ threadId, name }) =>
      control(threadId, (connectors) => connectors.reconnect(name)),
    "connectors.setEnabled": ({ threadId, name, enabled }) =>
      Effect.gen(function* () {
        const applied = yield* control(threadId, (connectors) =>
          connectors.setEnabled(name, enabled),
        );
        if (applied === "applied") return { session: "applied" as const };
        return { session: yield* runtimes.reloadSession(threadId) };
      }),
    "connectors.authenticate": ({ threadId, name }) =>
      control(threadId, (connectors) =>
        connectors.authenticate === undefined
          ? Effect.fail(
              new InvalidState({
                message: "This agent signs in to its MCP servers itself, outside Gram.",
                threadId,
              }),
            )
          : connectors.authenticate(name).pipe(Effect.map(toSignIn)),
      ),
    "connectors.add": (request: AddConnectorPayload) => withName(request.name, addServer(request)),
    "connectors.remove": (request: RemoveConnectorPayload) =>
      withName(request.name, removeServer(request)),
  } satisfies Partial<Handlers>;

  const serverIn = (
    target: McpTarget,
    folder: string,
    name: string,
  ): Effect.Effect<ConfiguredServer | undefined, string> =>
    (target === "claude"
      ? mcp.configured(folder).pipe(Effect.mapError((error) => error.message))
      : hosts.get(target).pipe(
          Effect.flatMap((host) =>
            host.mcpConfig === undefined
              ? Effect.succeed([])
              : host.mcpConfig.list({ cwd: folder, checkSignIn: false }),
          ),
          Effect.mapError((error) => redactText(detailOf(error.message, []))),
        )
    ).pipe(
      Effect.map((servers) => {
        const found = servers.find((server) => server.name === name);
        return found === undefined ? undefined : presentable(found);
      }),
    );

  return {
    handlers,
    /**
     * The writes behind `connectors.add` and `connectors.remove`, without the RPCs' lock, for a
     * caller that holds `withName` itself across a check and the writes.
     */
    writes: { withName, add: addServer, remove: removeServer, serverIn },
  };
});

/** The connectors' RPC handlers alone, as the RPC layer serves them before its local-app check. */
export const connectorHandlers = Effect.map(makeConnectorConfigs, (configs) => configs.handlers);

/** Why a server can't be added or removed over this connection. */
export const CONNECTOR_WRITES_LOCAL_ONLY =
  "MCP servers are added and removed from Gram on this computer, or by an agent's proposal you approve there.";

type CallHeaders = { readonly headers?: Readonly<Record<string, string | undefined>> } | undefined;

/**
 * `handlers` as the RPC layer serves them: adding or removing a server runs a program or reaches a
 * service as the user, so only the local app's own connection may do it (`isLocalApp`, which the
 * transport stamps and no caller can forge). A paired phone's socket is refused. An approved
 * `mcp_server_propose` writes in-process, through `ConnectorConfigs`' writes, not through here.
 */
export const localAppConnectorWrites = <
  H extends {
    readonly "connectors.add": (request: AddConnectorPayload) => Effect.Effect<unknown, unknown>;
    readonly "connectors.remove": (
      request: RemoveConnectorPayload,
    ) => Effect.Effect<unknown, unknown>;
  },
>(
  handlers: H,
): Omit<H, "connectors.add" | "connectors.remove"> & {
  readonly "connectors.add": (
    request: AddConnectorPayload,
    call?: CallHeaders,
  ) => ReturnType<H["connectors.add"]> | Effect.Effect<never, InvalidState>;
  readonly "connectors.remove": (
    request: RemoveConnectorPayload,
    call?: CallHeaders,
  ) => ReturnType<H["connectors.remove"]> | Effect.Effect<never, InvalidState>;
} => ({
  ...handlers,
  "connectors.add": (request: AddConnectorPayload, call?: CallHeaders) =>
    isLocalApp(call?.headers)
      ? (handlers["connectors.add"](request) as ReturnType<H["connectors.add"]>)
      : Effect.fail(new InvalidState({ message: CONNECTOR_WRITES_LOCAL_ONLY })),
  "connectors.remove": (request: RemoveConnectorPayload, call?: CallHeaders) =>
    isLocalApp(call?.headers)
      ? (handlers["connectors.remove"](request) as ReturnType<H["connectors.remove"]>)
      : Effect.fail(new InvalidState({ message: CONNECTOR_WRITES_LOCAL_ONLY })),
});

/**
 * The one set of connectors a server has: the RPCs serve its handlers, and `mcp_server_propose`
 * writes through its `writes`, so an approved proposal takes Settings → Connectors' own path, its
 * reloads, the forgetting of its last read and its per-name lock included.
 */
export class ConnectorConfigs extends Context.Service<
  ConnectorConfigs,
  Effect.Success<typeof makeConnectorConfigs>
>()("@gram/server/ConnectorConfigs") {
  static readonly layer = Layer.effect(ConnectorConfigs, makeConnectorConfigs);
}

/** The `connectors.*` group's handler layer. */
export const ConnectorHandlersLive = ConnectorRpcs.toLayer(
  Effect.gen(function* () {
    const { handlers } = yield* ConnectorConfigs;
    return ConnectorRpcs.of(logDefects(ConnectorRpcs, localAppConnectorWrites(handlers)));
  }),
);
