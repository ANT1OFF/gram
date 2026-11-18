// Workers an orchestrator sends to run on a server signed in to (`send_worker`), as threads of a
// workspace there, under that server's rules (docs/design/mocks/hosted-send-and-move, v1). Only
// where the workspace's charter allows it (`sendWork`, off by default), and only through the
// desktop app, which holds the sign-in (`embedding/sent-work-port.ts`).
//
// Here, each is a thread record that runs nothing (`Thread.sentTo`): listed with the
// orchestrator's workers, its brief and its replies kept, messaged and stopped there
// (`app-tools/orchestration-tools.ts`). This server follows each one that is still at work, and
// what it says comes to the orchestrator as the worker's report: a reply as progress or done, a
// question as a question, a failure as blocked. This machine holds none of its files; its pull
// request is how the work comes back.

import {
  AppToolError,
  parseRepoRemote,
  type SentTo,
  type SentWorkTarget,
  type Thread,
  type ThreadId,
  type WorkerReportState,
  WORKER_REPORT_SUMMARY_MAX,
} from "@gram/contracts";
import { git, Proc } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { defineAppTool } from "../app-tools/definition.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { SentWorkPort, type SentWorkPortShape } from "../embedding/sent-work-port.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { ThreadRuntimes, type ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { workerThreadId } from "./outbox.ts";
import { Orchestration, type OrchestrationShape } from "./service.ts";

const TOOL = "send_worker";

/** How often the open sent workers are looked for, and how long one unheard waits to try again. */
export const SENT_LOOK_EVERY = Duration.seconds(30);
export const SENT_RETRY_AFTER = Duration.seconds(60);

const fail = (message: string) => new AppToolError({ tool: TOOL, message });

/** A target as the orchestrator names it: "Platform · gram.example.com". */
export const targetName = (target: SentWorkTarget): string =>
  `${target.workspace} · ${hostOf(target.origin)}`;

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** The target `named` (its workspace's name or id, or the whole "workspace · host"), any case. */
export const pickTarget = (
  targets: ReadonlyArray<SentWorkTarget>,
  named: string | undefined,
): SentWorkTarget | string => {
  const listed = targets.map((target) => `"${targetName(target)}"`).join(", ");
  if (targets.length === 0)
    return "No server signed in to in the desktop app runs work sent to it. The user signs in under Settings → Machines.";
  if (named === undefined) {
    if (targets.length === 1) return targets[0]!;
    return `Name the workspace to send it to: ${listed}.`;
  }
  const wanted = named.trim().toLowerCase();
  const found = targets.filter(
    (target) =>
      target.workspaceId === named.trim() ||
      target.workspace.toLowerCase() === wanted ||
      targetName(target).toLowerCase() === wanted,
  );
  if (found.length === 1) return found[0]!;
  return found.length === 0
    ? `No workspace you may send to is named ${named}. These are: ${listed}.`
    : `More than one workspace is named ${named}: name it as one of ${listed}.`;
};

const cut = (text: string) =>
  text.length <= WORKER_REPORT_SUMMARY_MAX
    ? text
    : `${text.slice(0, WORKER_REPORT_SUMMARY_MAX - 1)}…`;

/** A thread's state there as the report it makes, and the words of it. */
export const reportOf = (
  sent: Pick<SentTo, "state" | "reply" | "server">,
): { readonly state: WorkerReportState; readonly summary: string } => {
  const said = (sent.reply ?? "").trim();
  switch (sent.state) {
    case "waiting":
      return {
        state: "question",
        summary: cut(
          `It waits on a person on ${sent.server}: an approval or a question there.${said === "" ? "" : ` Its last words: ${said}`}`,
        ),
      };
    case "failed":
      return {
        state: "blocked",
        summary: cut(`It failed on ${sent.server}.${said === "" ? "" : ` ${said}`}`),
      };
    case "stopped":
      return {
        state: "blocked",
        summary: cut(`It was stopped on ${sent.server}.${said === "" ? "" : ` ${said}`}`),
      };
    case "done":
      return { state: "done", summary: cut(said === "" ? `It finished on ${sent.server}.` : said) };
    case "running":
      return {
        state: "progress",
        summary: cut(said === "" ? `It is at work on ${sent.server}.` : said),
      };
  }
};

/** The repository a project's work is in, as a server clones it: never a local path or a sign-in. */
const repositoryOf = (root: string) =>
  git(root, ["config", "--get", "remote.origin.url"], { timeoutMs: 2_000 }).pipe(
    Effect.map((out) => (out.status === 0 ? out.stdout.trim() : "")),
    Effect.orElseSucceed(() => ""),
    Effect.map((url) => {
      if (url === "") return undefined;
      const remote = parseRepoRemote(url);
      if ("error" in remote) return undefined;
      return remote.kind === "github" ? `${remote.owner}/${remote.repo}` : remote.url;
    }),
  );

interface Deps {
  readonly orchestration: OrchestrationShape;
  readonly store: ThreadStoreShape;
  readonly runtimes: ThreadRuntimesShape;
  readonly port: SentWorkPortShape;
  /** Reads a project's remote. */
  readonly proc: Proc["Service"];
  /** Tells the follower a worker was just sent, so it is followed at once. */
  readonly sent?: (id: ThreadId) => Effect.Effect<void>;
}

/** `send_worker`: the brief goes there, and a record of it here. */
export const sendWorkerTool = (deps: Deps) =>
  defineAppTool({
    descriptor: {
      name: TOOL,
      class: "crossThread",
      description:
        "Send a worker to run on a server the user is signed in to in the Gram app, as a thread of a workspace there, where your workspace allows it (its charter's `sendWork`). It runs under that server's rules and approvals, keeps going while this computer sleeps, and works from the repository's remote: it sees nothing uncommitted here, so push the base first. Its replies come to you as its reports; message it with send_message and stop it with stop_thread as any worker. Give `project` (one of this workspace's), `title`, `feature` and a `brief` that stands alone; `workspace` names where it goes (left out, the one there is); `clientRequestId` makes a retry return the worker it made. Use it only when the user asks for work to run on a server.",
    },
    audience: ["orchestrator"],
    input: Schema.Struct({
      project: Schema.NonEmptyString,
      title: Schema.NonEmptyString,
      feature: Schema.NonEmptyString,
      brief: Schema.NonEmptyString,
      workspace: Schema.optionalKey(Schema.NonEmptyString),
      branch: Schema.optionalKey(Schema.NonEmptyString),
      clientRequestId: Schema.optionalKey(
        Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
      ),
      reason: Schema.optionalKey(Schema.String),
    }),
    // The work leaves this computer, so the user says yes to each, naming where it goes.
    needsApproval: () => Effect.succeed(true),
    describe: (_caller, input) =>
      Effect.succeed(
        `Send “${input.title.trim()}” to run on a server${input.workspace === undefined ? "" : ` (${input.workspace})`}, under its rules`,
      ),
    handle: (caller, input) => sendWorker(deps, caller, input),
  });

export const sendWorker = (
  { orchestration, store, runtimes, port, proc, sent: justSent }: Deps,
  callerId: ThreadId,
  input: {
    readonly project: string;
    readonly title: string;
    readonly feature: string;
    readonly brief: string;
    readonly workspace?: string;
    readonly branch?: string;
    readonly clientRequestId?: string;
    readonly reason?: string;
  },
) =>
  Effect.gen(function* () {
    const authority = yield* orchestration.authorityOf(callerId);
    if (authority === undefined)
      return yield* fail("Only a workspace's orchestrator sends workers.");
    const { thread: caller, state } = authority;
    if (state.charter.sendWork !== true)
      return yield* fail(
        "This workspace doesn't send work to servers. The user turns it on in the workspace's settings.",
      );
    if (state.paused !== undefined)
      return yield* fail(`Orchestration is paused (${state.paused.reason}), so nothing is sent.`);
    const workspaceId = state.workspace.id;
    // A retry finds the worker its first call made.
    const id =
      input.clientRequestId === undefined
        ? undefined
        : workerThreadId(workspaceId, `sent:${input.clientRequestId}`);
    if (id !== undefined) {
      const made = yield* store.getThread(id).pipe(Effect.option);
      if (Option.isSome(made)) {
        const sent = made.value.sentTo;
        if (sent === undefined || made.value.spawnedBy?.threadId !== caller.id)
          return yield* fail(
            `clientRequestId ${input.clientRequestId} made another thread. Use a new id.`,
          );
        return {
          threadId: made.value.id,
          title: made.value.title,
          existing: true,
          runsOn: `${sent.workspace} · ${hostOf(sent.origin)}`,
        };
      }
    }
    const projects = yield* store.listProjects;
    const wanted = input.project.trim().toLowerCase();
    const project = projects.find(
      (each) =>
        state.workspace.projectIds.includes(each.id) &&
        (each.id === input.project.trim() || each.name.toLowerCase() === wanted),
    );
    if (project === undefined)
      return yield* fail(`${input.project} isn't one of this workspace's projects.`);
    const repository = yield* repositoryOf(project.root).pipe(Effect.provideService(Proc, proc));
    if (repository === undefined)
      return yield* fail(
        `${project.name} has no remote a server could clone (its origin is missing, local or carries a sign-in). The work goes from the remote, never from this computer.`,
      );
    const listed = yield* port.targets();
    if (!listed.ok) return yield* fail(listed.why);
    const target = pickTarget(listed.targets, input.workspace);
    if (typeof target === "string") return yield* fail(target);
    const clientKey = (id ?? crypto.randomUUID()).replaceAll(/[^A-Za-z0-9_-]/g, "");
    const title = input.title.trim().slice(0, 200);
    const started = yield* port.send(target.origin, target.workspaceId, {
      repositories: [repository],
      text: input.brief,
      title,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      clientKey,
    });
    if (!started.ok)
      return yield* fail(
        `${target.server} didn't start it: ${started.why}${
          started.unknown === true && input.clientRequestId !== undefined
            ? " It may have started: call again with the same clientRequestId to find out."
            : ""
        }`,
      );
    const now = yield* Clock.currentTimeMillis;
    const sentTo: SentTo = {
      origin: target.origin,
      server: target.server.slice(0, 200),
      workspaceId: target.workspaceId,
      workspace: target.workspace.slice(0, 200),
      threadId: started.threadId,
      ...(started.branch === undefined ? {} : { branch: started.branch.slice(0, 200) }),
      at: now,
      state: "running",
    };
    const worker = yield* runtimes
      .create({
        ...(id === undefined ? {} : { id }),
        projectRoot: project.root,
        checkout: { kind: "main", path: project.root },
        title,
        workspaceId,
        spawnedBy: {
          threadId: caller.id,
          feature: input.feature.trim(),
          placement: {
            machine: targetName(target),
            ...(input.reason === undefined ? {} : { why: input.reason.trim().slice(0, 300) }),
          },
        },
        sentTo,
      })
      .pipe(Effect.mapError((error) => fail(error.message)));
    if (justSent !== undefined) yield* justSent(worker.id);
    return {
      threadId: worker.id,
      title: worker.title,
      runsOn: targetName(target),
      ...(started.branch === undefined ? {} : { branch: started.branch }),
      note: `It runs on ${target.server}, under its rules; its replies come to you as its reports.`,
    };
  });

/** One look at a sent worker: wait for what it does next, and record it. Never fails. */
export const followOnce = (
  { orchestration, store, port }: Pick<Deps, "orchestration" | "store" | "port">,
  thread: Thread,
) =>
  Effect.gen(function* () {
    const sent = thread.sentTo;
    if (sent === undefined) return "ended" as const;
    const waited = yield* port.wait(sent.origin, sent.workspaceId, sent.threadId, {
      ...(sent.latest === undefined ? {} : { after: sent.latest }),
      until: "reply",
      timeoutSeconds: 20,
    });
    const now = yield* Clock.currentTimeMillis;
    if (!waited.ok) {
      yield* store
        .updateThread(thread.id, (current) =>
          current.sentTo === undefined
            ? current
            : { ...current, sentTo: { ...current.sentTo, unheard: waited.why.slice(0, 300) } },
        )
        .pipe(Effect.ignore);
      return "unheard" as const;
    }
    const { happened, latest, reply, thread: there } = waited.waited;
    const next: SentTo = {
      ...sent,
      state: there.state,
      working: there.working,
      heardAt: now,
      ...(latest === undefined ? {} : { latest }),
      ...(reply === undefined ? {} : { reply }),
    };
    const { unheard: _heard, ...heard } = next;
    yield* store
      .updateThread(thread.id, (current) =>
        current.sentTo === undefined ? current : { ...current, sentTo: heard },
      )
      .pipe(Effect.ignore);
    // Something to tell: a reply, a question, or its end. A wait that only ran out says nothing.
    const changed = happened && (latest !== sent.latest || there.state !== sent.state);
    if (changed) yield* orchestration.recordReport(thread.id, reportOf(heard)).pipe(Effect.ignore);
    return there.state === "done" || there.state === "failed"
      ? ("ended" as const)
      : ("open" as const);
  });

/** The sent workers still worth following: open here, and at work or waiting there. */
const openSent = (store: ThreadStoreShape) =>
  store.listThreads.pipe(
    Effect.map((threads) =>
      threads.filter(
        (thread) =>
          thread.sentTo !== undefined &&
          !thread.parked &&
          thread.sentTo.state !== "done" &&
          thread.sentTo.state !== "failed",
      ),
    ),
  );

/** Follows every open sent worker, one fiber each, for as long as the server runs. */
const followAll = (
  deps: Pick<Deps, "orchestration" | "store" | "port">,
  kicks: Queue.Queue<ThreadId>,
) =>
  Effect.gen(function* () {
    const following = new Set<ThreadId>();
    const follow = (id: ThreadId): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (;;) {
          const thread = yield* deps.store.getThread(id).pipe(Effect.option);
          if (Option.isNone(thread) || thread.value.parked) return;
          const step = yield* followOnce(deps, thread.value);
          if (step === "ended") return;
          if (step === "unheard") yield* Effect.sleep(SENT_RETRY_AFTER);
        }
      }).pipe(Effect.ensuring(Effect.sync(() => following.delete(id))));
    for (;;) {
      for (const thread of yield* openSent(deps.store)) {
        if (following.has(thread.id)) continue;
        following.add(thread.id);
        yield* Effect.forkScoped(follow(thread.id));
      }
      // Again when a worker is sent, else after a while: one sent before a restart is found too.
      yield* Queue.take(kicks).pipe(Effect.timeoutOption(SENT_LOOK_EVERY));
    }
  });

/** `send_worker`, and the following of what was sent; nothing without the desktop app. */
export const SentWorkersLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const port = yield* SentWorkPort;
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    if (!port.available || orchestration === undefined) return;
    const kicks = yield* Queue.unbounded<ThreadId>();
    const deps: Deps = {
      sent: (id) => Queue.offer(kicks, id).pipe(Effect.asVoid),
      orchestration,
      store: yield* ThreadStore,
      runtimes: yield* ThreadRuntimes,
      port,
      proc: yield* Proc,
    };
    yield* (yield* AppToolRegistry).register([sendWorkerTool(deps)]);
    yield* Effect.forkScoped(followAll(deps, kicks));
  }),
);
