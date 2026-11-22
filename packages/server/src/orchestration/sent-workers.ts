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
/** The least time between two waits on one sent worker. */
export const SENT_WAIT_FLOOR = Duration.seconds(2);

const fail = (message: string) => new AppToolError({ tool: TOOL, message });

/**
 * Said under every brief sent: the thread there was started by a person, and has no orchestrator
 * or conversation of its own to report through, so without this it may look for one.
 */
export const SENT_BRIEF_NOTE =
  "This task was sent from Gram on another computer, by a workspace orchestrator that reads this thread. Your replies here are your reports to it: end with one that says what you did and found, and the pull request if you opened one. There is no conversation, report tool or other thread to answer through.";

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
export const repositoryOf = (root: string) =>
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
  readonly proc: Proc["Service"];
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
    resolve: (caller, input) =>
      Effect.gen(function* () {
        const listed = yield* deps.port.targets();
        const picked = listed.ok ? pickTarget(listed.targets, input.workspace) : undefined;
        if (typeof picked !== "object") return input;
        const there = yield* whatThere(deps, caller, input.project, picked);
        return {
          ...input,
          picked,
          ...(there.model === undefined ? {} : { pickedModel: there.model }),
          ...(there.repository === undefined ? {} : { repository: there.repository }),
          ...(there.workerModel === undefined ? {} : { workerModel: there.workerModel }),
        };
      }),
    needsApproval: () => Effect.succeed(true),
    title: (_caller, input: SendWorkerCall) =>
      Effect.succeed(
        input.picked === undefined
          ? "Send worker to a server?"
          : `Send worker to ${input.picked.server}?`,
      ),
    describe: (_caller, input: SendWorkerCall) =>
      Effect.succeed(
        input.picked === undefined
          ? `Send “${input.title.trim()}” from ${input.project.trim()} to a server${input.workspace === undefined ? "" : ` (${input.workspace})`}, under its rules`
          : `Send “${input.title.trim()}” from ${input.project.trim()} to run in ${targetName(input.picked)}, as a thread of that workspace. ${input.picked.organisation}'s rules and approvals apply there, and it runs on ${input.pickedModel === undefined ? "the model that workspace starts threads on" : modelLabel(input.pickedModel)}, ${input.workerModel === undefined ? "not this workspace's worker model" : `not ${modelLabel(input.workerModel)} that workers here run on`}.`,
      ),
    cardDetails: (input: SendWorkerCall) => ({
      ...(input.picked === undefined
        ? {}
        : {
            workspace: targetName(input.picked),
            organisation: input.picked.organisation,
            model:
              input.pickedModel === undefined
                ? "The one that workspace starts threads on"
                : modelLabel(input.pickedModel),
          }),
      ...(input.workerModel === undefined ? {} : { workerModel: modelLabel(input.workerModel) }),
      project: input.project,
      ...(input.repository === undefined ? {} : { repository: input.repository }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      title: input.title,
      ...(input.reason === undefined || input.reason.trim() === "" ? {} : { reason: input.reason }),
      brief: input.brief,
    }),
    handle: (caller, input: SendWorkerCall) => {
      const {
        picked,
        pickedModel: _model,
        repository: _repo,
        workerModel: _worker,
        ...call
      } = input;
      return sendWorker(
        deps,
        caller,
        picked === undefined
          ? call
          : { ...call, target: { origin: picked.origin, workspaceId: picked.workspaceId } },
      );
    },
  });

interface SendWorkerCall {
  readonly project: string;
  readonly title: string;
  readonly feature: string;
  readonly brief: string;
  readonly workspace?: string;
  readonly branch?: string;
  readonly clientRequestId?: string;
  readonly reason?: string;
  readonly picked?: SentWorkTarget;
  readonly pickedModel?: { readonly agent: string; readonly model: string };
  readonly repository?: string;
  readonly workerModel?: { readonly agent: string; readonly model: string };
}

const agents: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };

const modelLabel = (model: { readonly agent: string; readonly model: string }): string =>
  `${agents[model.agent] ?? model.agent} · ${model.model}`;

interface There {
  readonly repository?: string;
  readonly model?: { readonly agent: string; readonly model: string };
  readonly workerModel?: { readonly agent: string; readonly model: string };
}

const whatThere = (
  { orchestration, store, port, proc }: Deps,
  callerId: ThreadId,
  projectName: string,
  target: SentWorkTarget,
) =>
  Effect.gen(function* () {
    const authority = yield* orchestration.authorityOf(callerId);
    if (authority === undefined) return {};
    const models = authority.state.charter.workerModels ?? [];
    const local = models.find((each) => each.default === true) ?? models[0];
    const workerModel =
      local === undefined || !("model" in local)
        ? undefined
        : { agent: local.agent, model: local.model };
    const wanted = projectName.trim().toLowerCase();
    const project = (yield* store.listProjects).find(
      (each) =>
        authority.state.workspace.projectIds.includes(each.id) &&
        (each.id === projectName.trim() || each.name.toLowerCase() === wanted),
    );
    const repository =
      project === undefined
        ? undefined
        : yield* repositoryOf(project.root).pipe(Effect.provideService(Proc, proc));
    const checked =
      repository === undefined
        ? undefined
        : yield* port.check(target.origin, target.workspaceId, [repository]);
    const model = checked?.ok === true ? checked.reach.model : undefined;
    return {
      ...(repository === undefined ? {} : { repository }),
      ...(model === undefined ? {} : { model }),
      ...(workerModel === undefined ? {} : { workerModel }),
    } satisfies There;
  }).pipe(Effect.orElseSucceed((): There => ({})));

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
    /** Exactly where it goes, as a person picked it; else `workspace` names it. */
    readonly target?: { readonly origin: string; readonly workspaceId: string };
  },
  by: "orchestrator" | "person" = "orchestrator",
) =>
  Effect.gen(function* () {
    const authority = yield* orchestration.authorityOf(callerId);
    if (authority === undefined)
      return yield* fail("Only a workspace's orchestrator sends workers.");
    const { thread: caller, state } = authority;
    if (by === "orchestrator" && state.charter.sendWork !== true)
      return yield* fail(
        "This workspace doesn't send work to servers. The user turns it on in the workspace's settings.",
      );
    if (state.paused !== undefined)
      return yield* fail(`Orchestration is paused (${state.paused.reason}), so nothing is sent.`);
    const workspaceId = state.workspace.id;
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
    const target =
      input.target === undefined
        ? pickTarget(listed.targets, input.workspace)
        : (listed.targets.find(
            (each) =>
              each.origin === input.target?.origin && each.workspaceId === input.target.workspaceId,
          ) ??
          "That workspace isn't one this app may send work to now. Settings → Machines lists them.");
    if (typeof target === "string") return yield* fail(target);
    const clientKey = (id ?? crypto.randomUUID()).replaceAll(/[^A-Za-z0-9_-]/g, "");
    const title = input.title.trim().slice(0, 200);
    const started = yield* port.send(target.origin, target.workspaceId, {
      repositories: [repository],
      text: `${input.brief.trim()}\n\n${SENT_BRIEF_NOTE}`,
      title,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      clientKey,
    });
    if (!started.ok)
      return yield* fail(
        `${target.server} didn't start it: ${started.why}${
          started.unknown === true && input.clientRequestId !== undefined
            ? " It may have started: call again with the same clientRequestId to find out."
            : started.unknown === true
              ? ` It may have started there without a record here: tell the user to look in ${target.workspace} on ${target.server} before sending it again.`
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
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const made =
              id === undefined ? undefined : yield* store.getThread(id).pipe(Effect.option);
            if (
              made !== undefined &&
              Option.isSome(made) &&
              made.value.sentTo?.threadId === started.threadId
            )
              return made.value;
            yield* port
              .stop(target.origin, target.workspaceId, started.threadId)
              .pipe(Effect.ignore);
            return yield* fail(`${error.message} It was stopped on ${target.server}.`);
          }),
        ),
      );
    if (justSent !== undefined) yield* justSent(worker.id);
    return {
      threadId: worker.id,
      title: worker.title,
      runsOn: targetName(target),
      ...(started.branch === undefined ? {} : { branch: started.branch }),
      note: `It runs on ${target.server}, under its rules; its replies come to you as its reports.`,
    };
  });

/** Done, failed or stopped there: nothing more comes until it is messaged again. */
export const isEnded = (state: SentTo["state"]): boolean =>
  state === "done" || state === "failed" || state === "stopped";

/** One look at a sent worker: wait for what it does next, and record it (published to windows). Never fails. */
export const followOnce = (
  { orchestration, runtimes, port }: Pick<Deps, "orchestration" | "runtimes" | "port">,
  thread: Thread,
) =>
  Effect.gen(function* () {
    const sent = thread.sentTo;
    if (sent === undefined) return "ended" as const;
    const began = yield* Clock.currentTimeMillis;
    const waited = yield* port.wait(sent.origin, sent.workspaceId, sent.threadId, {
      ...(sent.latest === undefined ? {} : { after: sent.latest }),
      until: "reply",
      timeoutSeconds: 20,
    });
    const now = yield* Clock.currentTimeMillis;
    if (!waited.ok) {
      yield* runtimes
        .updateThread(thread.id, (current) =>
          current.sentTo === undefined
            ? current
            : { ...current, sentTo: { ...current.sentTo, unheard: waited.why.slice(0, 300) } },
        )
        .pipe(Effect.ignore);
      return "unheard" as const;
    }
    const { happened, latest, reply, thread: there } = waited.waited;
    let heard: SentTo | undefined;
    yield* runtimes
      .updateThread(thread.id, (current) => {
        if (current.sentTo === undefined) return current;
        const askedSince = (current.sentTo.askedAt ?? -1) >= began;
        const { unheard: _heard, ...rest } = current.sentTo;
        heard = {
          ...rest,
          state: askedSince && isEnded(there.state) ? "running" : there.state,
          working: there.working,
          heardAt: now,
          ...(latest === undefined ? {} : { latest }),
          ...(reply === undefined ? {} : { reply }),
        };
        return { ...current, sentTo: heard };
      })
      .pipe(Effect.ignore);
    if (heard === undefined) return "unheard" as const;
    const changed = (happened && latest !== sent.latest) || heard.state !== sent.state;
    if (changed) yield* orchestration.recordReport(thread.id, reportOf(heard)).pipe(Effect.ignore);
    return isEnded(heard.state) ? ("ended" as const) : ("open" as const);
  });

const openSent = (store: ThreadStoreShape) =>
  store.listThreads.pipe(
    Effect.map((threads) =>
      threads.filter(
        (thread) => thread.sentTo !== undefined && !thread.parked && !isEnded(thread.sentTo.state),
      ),
    ),
  );

const followAll = (
  deps: Pick<Deps, "orchestration" | "store" | "runtimes" | "port">,
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
          yield* Effect.sleep(step === "unheard" ? SENT_RETRY_AFTER : SENT_WAIT_FLOOR);
        }
      }).pipe(Effect.ensuring(Effect.sync(() => following.delete(id))));
    for (;;) {
      for (const thread of yield* openSent(deps.store)) {
        if (following.has(thread.id)) continue;
        following.add(thread.id);
        yield* Effect.forkScoped(follow(thread.id));
      }
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
