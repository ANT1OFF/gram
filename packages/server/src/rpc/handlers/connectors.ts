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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
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
import { redactText } from "../../logging/redact.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { AgentHosts } from "../../runtime/agent-hosts.ts";
import { ThreadRuntimes, type McpConfigChange } from "../../runtime/thread-runtimes.ts";
import { logDefects, type Handlers } from "./common.ts";

/** One line of what went wrong, with the server's env and header values masked. */
const detailOf = (text: string, secrets: ReadonlyArray<string>) =>
  redact(text.trim(), secrets).split("\n").slice(0, 3).join(" ");

/** Where `target` keeps the server: the scope asked for, or the nearest that agent has. */
const placement = (target: McpTarget, folder: string, scope: McpScope, name: string) => ({
  cwd: folder,
  scope: mcpScopeFor(target, scope),
  name,
});

const TARGETS: ReadonlyArray<McpTarget> = ["claude", "codex"];

/**
 * Whose sessions a write to `target`'s config at `scope` reaches: those in `folder` for a scope kept
 * per project, every one of the agent's otherwise. A remove with no scope may have taken the
 * server from any, so it reaches every one.
 */
const changeOf = (
  target: McpTarget,
  folder: string,
  scope: McpScope | undefined,
): McpConfigChange =>
  scope === undefined || mcpScopeFor(target, scope) === "user"
    ? { agent: target }
    : { agent: target, folder };

/** Where `claude mcp login` can't run: only a session that has the server can ask. */
const CLAUDE_SIGN_IN =
  "Claude Code signs in through a Claude thread running where this server is configured: start one there, or run claude in a terminal and open /mcp.";

/** How long a claude.ai connector's sign-in from Settings is watched for, and how often. */
const CONNECTOR_SIGN_IN_WAIT_MS = 5 * 60_000;
export const CONNECTOR_RECONNECT_EVERY_MS = 5_000;

/** A claude.ai connector's row in Claude Code's column, with nothing a config file would add. */
const hostedRow = (name: string): ConfiguredServer => ({
  name,
  transport: "other",
  scope: "claudeai",
  carriesValues: false,
});

/** A connector as a running Claude thread reports it, with its address, tools and claude.ai's word. */
const liveRow = ({ name, url, tools, claudeAi }: ConnectorStatus): ConfiguredServer => ({
  ...hostedRow(name),
  ...(url === undefined ? {} : { url }),
  ...(tools === undefined ? {} : { tools }),
  ...(claudeAi === undefined ? {} : { claudeAi }),
});

/**
 * A connector as a Claude thread last reported it: signed in or not as of `seenAt`. A state that
 * says nothing of the sign-in (`failed`, `pending`) is left unsaid, and so is `disabled`, which
 * Claude Code keeps per project.
 */
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

/** What became of a `claude mcp login` started here. */
type LoginOutcome =
  | { readonly state: "waiting" | "signedIn" }
  | { readonly state: "failed"; readonly message: string };

/**
 * The folder `claude mcp login` runs in for a row: a `user` server is the same from anywhere, so
 * the home folder, where no project's server of the same name can shadow it.
 */
const loginFolder = (scope: string | undefined, folder: string | undefined) =>
  scope === undefined || scope === "user" || folder === undefined ? homedir() : folder;

/**
 * A sign-in's outcome is for one server: its folder, name and address, so a different server added
 * later under the name doesn't inherit it.
 */
const loginKey = (folder: string, name: string, url: string | undefined) =>
  [folder, name, url ?? ""].join("\u0000");

const loginKeyName = (key: string) => key.split("\u0000")[1];

/** One agent's servers as its list read them, and for Claude Code where its connectors are from. */
interface AgentList {
  readonly servers: ReadonlyArray<ConfiguredServer>;
  readonly claudeAiFrom?: ClaudeAiSource;
  /** Why the running Claude threads list none of the account's claude.ai connectors. */
  readonly claudeAiUnavailable?: string;
}

/** A running Claude thread's connectors, the folder it runs in, and what it reports. */
interface LiveClaude {
  readonly threadId: ThreadId;
  readonly folder: string;
  readonly connectors: AgentConnectors;
  readonly status: ReadonlyArray<ConnectorStatus>;
}

/** Claude Code scopes whose servers differ by folder. */
const PER_FOLDER: ReadonlySet<string> = new Set<McpScope>(["local", "project"]);

/**
 * The session whose server a Settings row is: it lists `name` under the row's `scope`, since a
 * `local` or `project` server shadows the user's of the same name, and for a per-folder scope
 * it runs in the row's folder. The first such, in `liveClaudes` order.
 */
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

/** A started sign-in as the UI gets it: the page to open, or nothing to do but wait. */
const toSignIn = (started: ConnectorSignInStart): ConnectorSignIn =>
  started === "started"
    ? { kind: "started" }
    : { kind: "open", authorizationUrl: started.authorizationUrl };

/** A flag whose value is a credential, as `--api-key` and `--token` are. */
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

/**
 * How long a running Claude thread gets to reconnect a server and list it again before it is left
 * to restart instead.
 */
const LIVE_RELOAD_TIMEOUT_MS = 10_000;

/**
 * Has each of `sessions` reload `name` in place, at once, mid-turn too, as a sign-in's reconnect
 * always has. Claude Code's reconnect reads the server's entry from disk again, so a server added
 * or edited since the session started comes up as it is now (SDK 0.3.292, probed with a temp
 * home). Returns the threads that list it after, whether or not it connected; one that didn't
 * answer in time isn't among them.
 */
const reloadLive = (sessions: ReadonlyArray<LiveClaude>, name: string) =>
  Effect.forEach(
    sessions,
    ({ threadId, connectors }) =>
      connectors.reconnect(name).pipe(
        // A server that can't connect is still the new entry: the session has what it would on
        // a restart.
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

export const connectorHandlers = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const store = yield* ThreadStore;
  const hosts = yield* AgentHosts;
  const mcp = yield* McpCli;
  const catalogue = yield* McpCatalogue;
  const seenConnectors = yield* ClaudeAiSeen;
  /**
   * The last read of every agent's servers, by folder, so Settings and every panel get one answer
   * at once rather than each waiting on the agents. A configure through
   * Gram forgets it, and a newer read replaces it in the background.
   */
  const configuredCache = new Map<
    string,
    { readonly agents: ReadonlyArray<AgentConfiguredServers>; readonly at: number }
  >();
  const configuredRefreshes = yield* FiberMap.make<string>();
  /**
   * Bumped by each configure through Gram. A read started before it may have read the
   * config before the write, so it never becomes the last read, and no read after joins it.
   */
  let generation = 0;
  const logins = yield* FiberMap.make<string>();
  /**
   * Each agent's list in flight, by agent, folder and whether sign-ins were asked. One the page
   * stopped waiting for runs on: interrupting Codex's mid-start left its app-server spawned but
   * never kept, so each refresh started another. The next read joins it instead.
   */
  const lists = yield* FiberMap.make<string, AgentList, string>();
  /**
   * The outcome of each sign-in started through `claude mcp login`, by `loginKey`, so a page with
   * no Claude thread running can tell it finished. Only the servers the user signed in to from
   * here; a new start replaces the old, and adding or removing a server of the name forgets it.
   */
  const loginOutcomes = new Map<string, LoginOutcome>();
  /** Stops the logins still running for `name` and forgets every outcome for it. */
  const forgetLogins = (name: string) =>
    // Suspended, so the keys are those of when it runs: after the config command, not before.
    Effect.suspend(() =>
      Effect.forEach(
        [...loginOutcomes.keys()].filter((key) => loginKeyName(key) === name),
        (key) =>
          // Stopped first, so a login finishing now can't record its outcome again.
          FiberMap.remove(logins, key).pipe(
            Effect.andThen(Effect.sync(() => loginOutcomes.delete(key))),
          ),
        { discard: true },
      ),
    );

  // A sign-in from Settings that Codex finished reaches their running sessions only
  // through a restart: the token is the agent's, kept for every folder and profile.
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

  /** The session's connectors, or why there are none: no live session, or an agent without them. */
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

  /**
   * The folder a per-project scope means (the thread's checkout), and the agent a request without
   * targets is for: the thread's own, since no other agent reads that one's config. Settings has
   * neither thread nor folder, which is enough for the `user` scope: that one is the same from
   * anywhere, so it is written from the home folder.
   */
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

  /**
   * Writes each target in turn and stops at the first that fails, saying which already took the
   * change, so a retry isn't a surprise. Then every live session that reads what changed loads
   * it: a Claude thread live where it can (`reloadClaude`), any other once idle
   * (`mcpConfigChanged`). With that turned off, the thread's own reopens to load it.
   */
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
      // The last read no longer says what the configs hold, nor does any read still running.
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

  /**
   * Every running Claude thread's connectors with what they report, the ones in `folder` first:
   * the only source for Claude Code's sign-ins and for the account's claude.ai connectors, neither
   * of which is in a config file, and the only way to start a sign-in. A thread that doesn't
   * answer is left out.
   */
  const liveClaudes = (folder: string | undefined) =>
    Effect.gen(function* () {
      const live = (yield* runtimes.snapshot)
        .filter(({ thread, status }) => thread.model.agent === "claude" && status !== "cold")
        .toSorted(
          (a, b) =>
            Number(effectiveCheckout(b.thread).path === folder) -
            Number(effectiveCheckout(a.thread).path === folder),
        );
      // Asked all at once, each for at most `LIVE_STATUS_TIMEOUT_MS`: one at a time, a thread busy
      // connecting its servers held every view of the list behind it. One that doesn't answer in
      // time says nothing, so its servers' sign-ins stay unknown rather than the list waiting.
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

  /**
   * After `name` was added or edited in Claude Code's config: the running Claude threads `change`
   * reaches reload it live, and those that needn't restart are returned. A session confined to
   * other servers (`allowlist`) never takes it, so it needs neither. A removal never goes this way:
   * a reconnect leaves a removed server listed, and switching it off instead sticks in Claude
   * Code's config, so a server added back later would come up off.
   */
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

  /**
   * Runs `claude mcp login` until the user has finished in the browser, then reconnects the
   * running Claude threads still waiting on that server, since Claude Code tells none of them.
   * Returns once it has started; `loginOutcomes` says how it ended.
   */
  const startLogin = (
    login: NonNullable<McpCliShape["login"]>,
    name: string,
    folder: string,
    url: string | undefined,
  ): Effect.Effect<ConnectorSignInStart> => {
    const key = loginKey(folder, name, url);
    // One that didn't answer the reconnect restarts once idle, as after any change to its servers.
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
      // A second click starts over: the first login is stopped and its process reaped.
      Effect.andThen(FiberMap.run(logins, key, run)),
      Effect.as("started" as const),
    );
  };

  /**
   * Has the running Claude threads still waiting on claude.ai connector `name` reconnect now and
   * then, until one has it or the wait is over: claude.ai tells nobody when the user finishes, and
   * a thread that started before then would otherwise stay signed out.
   */
  const watchConnector = (name: string) =>
    Effect.gen(function* () {
      const until = (yield* Clock.currentTimeMillis) + CONNECTOR_SIGN_IN_WAIT_MS;
      while ((yield* Clock.currentTimeMillis) < until) {
        yield* Effect.sleep(CONNECTOR_RECONNECT_EVERY_MS);
        const sessions = yield* liveClaudes(undefined);
        const listed = sessions.flatMap(({ status }) => status.filter((c) => c.name === name));
        // Over once every copy reported is past its sign-in; a reconnect still running isn't yet.
        if (listed.length > 0 && listed.every((c) => !awaitsSignIn(c) && c.status !== "pending")) {
          return;
        }
        // Not restarted when one doesn't answer: the user may not have finished yet.
        yield* reloadLive(
          sessions.filter(({ status }) => status.some((c) => c.name === name && awaitsSignIn(c))),
          name,
        );
      }
    });

  /**
   * A claude.ai connector's sign-in with no Claude thread that has it: `claude mcp login` prints
   * claude.ai's page for it, which the UI opens. The CLI retains authentication ownership.
   */
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
      // A second click starts the watch over. Keyed apart from every `claude mcp login` that waits.
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

  /**
   * The account's claude.ai connectors for Claude Code's column: from a running Claude thread that
   * has them, else as Claude threads last reported them, else, before any did, the ones Claude
   * Code has connected before. Asks no session anything a view of its servers wouldn't.
   */
  const hostedRows = (sessions: ReadonlyArray<LiveClaude>) =>
    Effect.gen(function* () {
      const ever = new Set(yield* mcp.everConnected ?? Effect.succeed([]));
      // A gateway or confined thread has none, which says nothing of the account's.
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
      // Read from the session a sign-in would go to, so the two never disagree; with none, from
      // the sign-in last started here.
      // A connected session is the last word; a failed sign-in started here is reported beside a
      // session that is still waiting, so the page stops waiting too.
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
      // Said only when every running Claude thread is on a gateway key; none running says nothing.
      const unavailable = sessions.every((session) => session.connectors.claudeAiUnavailable)
        ? sessions[0]?.connectors.claudeAiUnavailable
        : undefined;
      return {
        servers: [...servers, ...rows].map((server) => ({ ...server, ...signInOf(server) })),
        ...(rows.length === 0 ? {} : { claudeAiFrom: hosted.from }),
        ...(unavailable === undefined ? {} : { claudeAiUnavailable: unavailable }),
      };
    });

  /** One agent's list. A config that can't be read is that agent's `error`, not the page's. */
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
            // A parse error may quote the config, and here nobody knows its secrets to mask them.
            Effect.mapError((error) => redactText(detailOf(error.message, []))),
          );
    const threadless = target === "claude" ? { threadlessSignIn: mcp.login !== undefined } : {};
    return Effect.gen(function* () {
      const since = generation;
      // A read from before a configure runs on unjoined; one after it reads the config afresh.
      const key = `${since}|${target}|${folder ?? ""}|${checkSignIn}`;
      const current = FiberMap.getUnsafe(lists, key);
      // `onlyIfMissing` interrupts the new fiber, not the old, when another read got in between:
      // that read's is the one to join.
      const running = Option.isSome(current)
        ? current.value
        : yield* FiberMap.run(lists, key, read, { onlyIfMissing: true }).pipe(
            Effect.map((fiber) => Option.getOrElse(FiberMap.getUnsafe(lists, key), () => fiber)),
          );
      const { servers, ...more } = yield* Fiber.join(running).pipe(
        // Codex's list starts its app-server first, which has no bound of its own; the other
        // agents' lists don't wait on it. Only the wait is cut short: the list goes on (`lists`).
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

  /** Every agent's servers in `folder`, read now, and kept as the last read unless sign-ins were asked. */
  const readConfigured = (folder: string | undefined, checkSignIn: ReadonlyArray<McpTarget>) =>
    Effect.gen(function* () {
      const since = generation;
      const agents = yield* Effect.forEach(
        TARGETS,
        (target) => configuredFor(target, folder, checkSignIn.includes(target)),
        { concurrency: "unbounded" },
      );
      // One that began before a configure may hold the config from before the write.
      if (checkSignIn.length === 0 && since === generation) {
        configuredCache.set(folder ?? "", { agents, at: yield* Clock.currentTimeMillis });
      }
      return agents;
    });

  /**
   * The last read of `folder`, at once, with a newer one started behind it once it is a few seconds
   * old, and whether one is still running, so the reader asks again for it; the first read of a
   * folder, and one the user asked for, is waited for.
   */
  const configuredAgents = (folder: string | undefined, fresh: boolean) =>
    Effect.gen(function* () {
      const key = folder ?? "";
      const cached = configuredCache.get(key);
      if (fresh || cached === undefined) {
        return { agents: yield* readConfigured(folder, []), refreshing: false };
      }
      // By generation too, so one from before a configure doesn't stand for one after it.
      const running = `${generation}|${key}`;
      if ((yield* Clock.currentTimeMillis) - cached.at > CONFIGURED_REFRESH_MS) {
        yield* FiberMap.run(configuredRefreshes, running, readConfigured(folder, []), {
          onlyIfMissing: true,
        });
      }
      // A read that has landed already is the answer; one still running is said to be.
      const refreshing = yield* FiberMap.has(configuredRefreshes, running);
      return { agents: (configuredCache.get(key) ?? cached).agents, refreshing };
    });

  return {
    // A view of the agents' own configs, never a registry: the last read is kept only so every view
    // answers at once, and each agent's own config stays the truth.
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
    // Read afresh each time the user asks, from GitHub; none of the servers listed is contacted.
    "connectors.catalogue": () => catalogue.read,
    "connectors.signIn": threadlessSignIn,
    // Live status belongs to the agent session.
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
    // An agent that can't toggle live applies it on reopen, through the runtime's reopen-when-idle.
    "connectors.setEnabled": ({ threadId, name, enabled }) =>
      Effect.gen(function* () {
        const applied = yield* control(threadId, (connectors) =>
          connectors.setEnabled(name, enabled),
        );
        if (applied === "applied") return { session: "applied" as const };
        return { session: yield* runtimes.reloadSession(threadId) };
      }),
    // The agent runs the OAuth flow and keeps the token; only the page to open passes through here.
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
    "connectors.add": (request) =>
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
      ),
    "connectors.remove": (request) =>
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
      ),
  } satisfies Partial<Handlers>;
});

/** The `connectors.*` group's handler layer. */
export const ConnectorHandlersLive = ConnectorRpcs.toLayer(
  Effect.map(connectorHandlers, (handlers) =>
    ConnectorRpcs.of(logDefects(ConnectorRpcs, handlers)),
  ),
);
