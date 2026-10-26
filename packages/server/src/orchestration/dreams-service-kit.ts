// Shared fixtures for the Dream service tests, which are split across files so they run side by side.
import type { AgentHost } from "@gram/agents";
import {
  InvalidState,
  NotFound,
  type AgentSessionSummary,
  type Dream,
  type DreamId,
  type DreamMode,
  type ServerEvent,
  type SessionTranscript,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import { canonicalizeOrOwned } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadArchive, ThreadArchiverLive, type ArchiveCaps } from "./archive.ts";
import { DreamFiles } from "./dream-files.ts";
import { type AnswerDelivery } from "./dream-handler.ts";
import { Dreams, makeDreamsLive } from "./dreams.ts";
import {
  completeTurn,
  makeWorld,
  serverLayer,
  waitReal,
  waitSent,
  type Server,
  type World,
} from "./test-harness.ts";

// Built at run time so no scanner mistakes the fixture for a leaked credential.
export const githubToken = `ghp_${"e5F6".repeat(9)}`;

/** The agents' own history as a test tells it: what each kind lists per folder, and what reads back. */
export interface History {
  readonly claude: ReadonlyArray<AgentSessionSummary & { readonly listedIn: string }>;
  readonly codex: ReadonlyArray<AgentSessionSummary & { readonly listedIn: string }>;
  readonly grok?: ReadonlyArray<AgentSessionSummary & { readonly listedIn: string }>;
}

/** One entry of a test's history; `cwd` only where the agent names the folder itself. */
export const pastSession = (
  agentSessionId: string,
  updatedAt: number,
  listedIn: string,
  cwd?: string,
): History["claude"][number] => ({
  agentSessionId,
  title: `Session ${agentSessionId}`,
  updatedAt,
  listedIn,
  ...(cwd === undefined ? {} : { cwd }),
});

const NO_HISTORY: History = { claude: [], codex: [] };

export const real = canonicalizeOrOwned;

const lister =
  (sessions: History["claude"]): NonNullable<AgentHost["listSessions"]> =>
  ({ cwd }) =>
    Effect.succeed(
      sessions
        .filter((session) => real(session.listedIn) === real(cwd))
        .map((session): AgentSessionSummary => ({
          agentSessionId: session.agentSessionId,
          title: session.title,
          updatedAt: session.updatedAt,
          ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        })),
    );

/** Fake hosts with explicitly invented history. */
const historyHosts = (history: History, modelGate?: () => Effect.Effect<boolean>) =>
  Layer.effect(
    AgentHosts,
    Effect.gen(function* () {
      const inner = yield* AgentHosts;
      return AgentHosts.of({
        get: (kind) =>
          inner.get(kind).pipe(
            Effect.map((host): AgentHost => {
              const sessions = history[kind] ?? [];
              return {
                ...host,
                listModels: (input) =>
                  (modelGate?.() ?? Effect.succeed(true)).pipe(
                    Effect.flatMap((available) =>
                      available ? host.listModels(input) : Effect.succeed([]),
                    ),
                  ),
                listSessions: lister(sessions),
                // Scoped to the folder asked for, as each adapter's is.
                readSession: ({ cwd, agentSessionId }) =>
                  sessions.some(
                    (session) =>
                      session.agentSessionId === agentSessionId &&
                      real(session.cwd ?? session.listedIn) === real(cwd),
                  )
                    ? Effect.succeed<SessionTranscript>({
                        agentSessionId,
                        cwd,
                        messages: [
                          { role: "user", text: `What did ${agentSessionId} decide?`, at: 1000 },
                          { role: "assistant", text: `Deploy on merge. Token ${githubToken}.` },
                        ],
                      })
                    : Effect.fail(new NotFound({ entity: "session", id: agentSessionId })),
              };
            }),
          ),
      });
    }),
  );

export interface DreamWorld {
  readonly modelGate?: () => Effect.Effect<boolean>;
  readonly onListDreams?: (rows: ReadonlyArray<Dream>) => Effect.Effect<void>;
  readonly beforePrepare?: (workspaceId: WorkspaceId) => Effect.Effect<void, never, ThreadStore>;
  readonly history?: History;
  readonly caps?: ArchiveCaps;
  readonly claudeConfigDirs?: ReadonlyArray<string>;
  readonly onValidation?: (
    stage: "inputs" | "output" | "baseline",
    dreamId: string,
  ) => Effect.Effect<void>;
}

export const memoryRoot = (world: World) => nodePath.join(world.dir, "memory");
export const noValidation = () => Effect.void;

const dreamLayer = (world: World, options: DreamWorld) =>
  Layer.mergeAll(
    makeDreamsLive({ claudeConfigDirs: options.claudeConfigDirs ?? [] }).pipe(
      Layer.provide(historyHosts(options.history ?? NO_HISTORY, options.modelGate)),
      Layer.provide(
        options.onListDreams === undefined
          ? Layer.empty
          : Layer.effect(
              ThreadStore,
              Effect.gen(function* () {
                const store = yield* ThreadStore;
                return {
                  ...store,
                  listDreams: (id: WorkspaceId) =>
                    store.listDreams(id).pipe(Effect.tap(options.onListDreams!)),
                };
              }),
            ),
      ),
    ),
    ThreadArchiverLive,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        options.onValidation === undefined && options.beforePrepare === undefined
          ? DreamFiles.layerAt(memoryRoot(world))
          : Layer.effect(
              DreamFiles,
              Effect.gen(function* () {
                const files = yield* DreamFiles;
                const before = options.onValidation ?? noValidation;
                const store = yield* ThreadStore;
                return {
                  ...files,
                  prepare: (input) =>
                    (options.beforePrepare?.(input.workspaceId as WorkspaceId) ?? Effect.void).pipe(
                      Effect.provideService(ThreadStore, store),
                      Effect.andThen(files.prepare(input)),
                    ),
                  verifyInputs: (workspaceId, dreamId) =>
                    before("inputs", dreamId).pipe(
                      Effect.andThen(files.verifyInputs(workspaceId, dreamId)),
                    ),
                  collectOutput: (workspaceId, dreamId) =>
                    before("output", dreamId).pipe(
                      Effect.andThen(files.collectOutput(workspaceId, dreamId)),
                    ),
                  baseline: (workspaceId, dreamId) =>
                    before("baseline", dreamId).pipe(
                      Effect.andThen(files.baseline(workspaceId, dreamId)),
                    ),
                };
              }),
            ).pipe(Layer.provide(DreamFiles.layerAt(memoryRoot(world)))),
        ThreadArchive.layerAt(memoryRoot(world), options.caps),
      ),
    ),
    Layer.provideMerge(serverLayer(world)),
  );

export type DreamServer = Server | Dreams | DreamFiles | ThreadArchive;

/** Like the harness's `withServer`, with dreams on top: calling it twice over one world is a restart. */
export const withDreams = <A, E>(
  world: World,
  body: Effect.Effect<A, E, DreamServer | Scope.Scope>,
  options: DreamWorld = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(dreamLayer(world, options));
      return yield* body.pipe(Effect.provide(context));
    }),
  );

export const inDreams = <A, E>(
  body: (world: World) => Effect.Effect<A, E, DreamServer | Scope.Scope>,
  options: DreamWorld = {},
) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withDreams(world, body(world), options);
  });

export const waitDream = (dreamId: DreamId, status: Dream["status"]) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return yield* waitReal(
      `dream ${status}`,
      store.getDream(dreamId).pipe(Effect.map((dream) => dream.status === status && dream)),
    );
  });

export const writeOutput = (dream: Dream, files: Readonly<Record<string, string>>) => {
  // Successful synthetic candidates carry an actual report; refusal tests write directly.
  files = {
    "REPORT.md": "# Review\n\nReviewed the synthetic input; changes are listed in the candidate.\n",
    ...files,
  };
  for (const [path, content] of Object.entries(files)) {
    const target = nodePath.join(dream.outputDir, "output", path);
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
};

/** Starts a consolidating dream and waits for its prompt to reach the agent. */
export const startDream = (workspaceId: WorkspaceId, instructions?: string, mode?: DreamMode) =>
  Effect.gen(function* () {
    const dreams = yield* Dreams;
    const dream = yield* dreams.start({ workspaceId, kind: "dream", instructions, mode });
    return { dream, session: yield* waitSent(dream.threadId as ThreadId, 1) };
  });

/** The agent says `done`, and the service has judged what it left. */
export const finishDream = (dream: Dream, session: FakeSession, status: Dream["status"]) =>
  Effect.gen(function* () {
    yield* completeTurn(session, "done");
    return yield* waitDream(dream.id, status);
  });

/** The newest merge session once its prompt is sent; merges run as sessions, not threads. */
export const waitMergeSession = (count = 1) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return yield* waitReal(
      `merge session ${count}`,
      Effect.sync(() => {
        const found = fake.sessions.filter((s) => s.options.threadId.startsWith("merge-"));
        const session = found[count - 1];
        return session !== undefined && session.sent.length > 0 ? session : undefined;
      }),
    );
  });

/** The merge of `path` in the review, once it has left `running`. */
export const waitMerged = (dreamId: DreamId, path: string) =>
  Effect.gen(function* () {
    const dreams = yield* Dreams;
    return yield* waitReal(
      `merge of ${path}`,
      dreams.review(dreamId).pipe(
        Effect.map((review) => {
          const merge = review.files.find((file) => file.path === path)?.merge;
          return merge !== undefined && merge.status !== "running" && merge;
        }),
      ),
    );
  });

export const titles = (events: ReadonlyArray<ServerEvent>) =>
  events.flatMap((event) => (event.type === "notify" ? [event.title] : []));

export const filesUnder = (dir: string): ReadonlyArray<string> =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          nodePath
            .join(entry.parentPath, entry.name)
            .slice(dir.length + 1)
            .replaceAll("\\", "/"),
        )
        .toSorted()
    : [];

/** The files a dream was given to read, by name. */
export const sessionsOf = (dream: Dream): Readonly<Record<string, string>> => {
  const dir = nodePath.join(dream.outputDir, "input", "sessions");
  return Object.fromEntries(
    filesUnder(dir).map((name) => [name, fs.readFileSync(nodePath.join(dir, name), "utf8")]),
  );
};

/** One more exchange with the orchestrator, its user message and its reply. */
export const exchange = (
  thread: { readonly id: ThreadId },
  session: FakeSession,
  ask: string,
  reply: string,
) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const sent = session.sent.length;
    yield* runtimes.send(thread.id, { text: ask });
    yield* waitSent(thread.id, sent + 1);
    yield* completeTurn(session, reply);
  });

/** Ends a running dream with a one-file memory and adopts it as the user would. */
export const adoptDream = (dream: Dream, session: FakeSession, memory = "# Memory index\n") =>
  Effect.gen(function* () {
    const dreams = yield* Dreams;
    writeOutput(dream, { "MEMORY.md": memory });
    yield* finishDream(dream, session, "completed");
    const review = yield* dreams.review(dream.id);
    return yield* dreams.adopt(dream.id, {
      basedOn: review.memoryVersion,
      outputDigest: review.outputDigest,
    });
  });

/** Stops a running dream and discards it. */
export const dropDream = (dream: Dream) =>
  Effect.gen(function* () {
    const dreams = yield* Dreams;
    yield* dreams.cancel(dream.id);
    yield* dreams.discard(dream.id);
  });

export const ANSWERED_FILE = "# Questions\n\n## Q1 · open · 2026-09-20\nRetry on 429?\n";
export const ANSWER_TO = { questionId: "Q1", question: "Retry on 429?" } as const;
/** A delivery that fails the first `failures` times; `record` says whether a failed one got in first. */
export const flaky = (failures: number, record: boolean, meanwhile?: Effect.Effect<void>) => {
  const held: string[] = [];
  let calls = 0;
  const count = () => calls;
  const delivery: AnswerDelivery<InvalidState> = {
    deliver: (text) =>
      Effect.gen(function* () {
        calls += 1;
        if (meanwhile !== undefined) yield* meanwhile;
        if (calls <= failures) {
          if (record) held.push(text);
          return yield* new InvalidState({ message: "the session went away" });
        }
        held.push(text);
        return "sent" as const;
      }),
    holds: (tag) => Effect.sync(() => held.some((text) => text.includes(tag))),
  };
  return { delivery, held, count };
};

export const completeConversation = (root: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const conversation = yield* runtimes.create({
      projectRoot: root,
      checkout: { kind: "main", path: root },
      model: { agent: "claude", model: "default" },
      mode: "default",
      input: { text: "Synthetic consolidation completion." },
    });
    yield* completeTurn(yield* waitSent(conversation.id, 1));
    yield* runtimes.markCompleted(conversation.id, "user");
    return conversation;
  });
