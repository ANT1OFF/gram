/**
 * Moving a workspace from one Gram to another: `exportWorkspace` writes a workspace as a bundle
 * (`WorkspaceBundle`), and `importWorkspace` on another server takes one in. Both sit behind the
 * hosted features setting and do nothing while it is off.
 *
 * What moves is what can live anywhere: the charter, stages and groups, the orchestrator's
 * conversation, its memory, the feature cards, the audit, and each worker's transcript. What is
 * tied to the machine stays there and is never in a bundle: agent sessions, worktrees and what was
 * not pushed from them, folder grants, approvals in flight, file checkpoints, credentials.
 *
 * So the orchestrator arrives as its own thread, under its own id and with its conversation, on a
 * new session that boots from its memory as a handoff's does, and is told in its first digest what
 * came with it and what did not. Workers arrive as finished ones: their transcripts go to the
 * archive, where the Workers tab reads them, and the orchestrator is told what each was doing and
 * on which branch, so it can start a worker here to carry one on.
 *
 * Invariants. An import replaces nothing: a workspace, thread or turn that is already here refuses
 * it before anything is written. A bundle is input from somewhere else and is trusted for nothing:
 * every id that names a folder is checked, the memory set meets the caps a dream's does, text is
 * scrubbed on the way out and again by the archive and memory on the way in, and the orchestrator
 * opens on the model and mode this server decides for the charter, in the folders this server was
 * told, never on the bundle's.
 */
import {
  availableWorkspaceName,
  BUNDLE_EVENTS_MAX,
  BUNDLE_MESSAGES_MAX,
  BUNDLE_WORKERS_MAX,
  bundleReadable,
  effectiveCheckout,
  embeddingOn,
  InvalidState,
  type BundleProject,
  type BundleWorker,
  type ExportWorkspaceInput,
  type ImportWorkspaceInput,
  type ImportWorkspaceResult,
  type NotFound,
  type Project,
  type ProjectId,
  type Thread,
  type ThreadStatus,
  type WorkspaceBundle,
  type WorkspaceState,
  WORKSPACE_BUNDLE_FORMAT,
} from "@gram/contracts";
import { cachedOriginUrl, Proc, projectRootKey } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { registerRepo } from "../fs/folders.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { redactText } from "../logging/redact.ts";
import { renderClosedThread, ThreadArchive } from "../orchestration/archive.ts";
import { checkMemorySet, OrchestrationMemory } from "../orchestration/memory.ts";
import { decodeOutbox, emptyOutbox, encodeOutbox } from "../orchestration/outbox.ts";
import { Orchestration } from "../orchestration/service.ts";
import { refuseConnectorEntries } from "../orchestration/service/kit.ts";
import { migrations } from "../persistence/migrations.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeClosedReopener } from "../rpc/handlers/closed-threads.ts";
import type { CheckoutService } from "../runtime/hooks.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";

/** Why nothing here runs while the hosted features setting is off. */
export const TRANSFER_OFF =
  "Moving a workspace between servers is a hosted feature, and hosted features are off here.";

/** How many schema migrations this build's database has run. */
const SCHEMA = Object.keys(migrations).length;

/** An id that may name a folder or a file: what Gram's own ids are, and nothing a path could use. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The statuses in which a thread is in the middle of a turn, which no bundle can carry. */
const MID_TURN: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

const refuse = (message: string) => new InvalidState({ message });

/** `value` with every string in it scrubbed of what looks like a credential. */
export const scrubbed = <A>(value: A): A => {
  if (typeof value === "string") return redactText(value) as A;
  if (Array.isArray(value)) return value.map(scrubbed) as A;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, scrubbed(inner)]),
    ) as A;
  }
  return value;
};

/**
 * A repository's `origin` as it may be said to another server: a network address, with no
 * password, no token standing in for a user, no query and no fragment; `undefined` for anything
 * else, such as a path on this machine.
 */
export const shareableRemote = (url: string): string | undefined => {
  const text = url.trim();
  // `git@host:owner/repo.git`, which names an account and no secret.
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(text)) return text;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
  // Over https a user is a token as often as a name; over ssh it is the account, kept bare.
  if (parsed.protocol !== "ssh:") parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

/**
 * An orchestrator's record as it may leave one machine and be taken in by another: what names it
 * and nothing else. Its session, folders, limits, pull requests, watches and marks are the
 * machine's; an import fills in the project, model, mode and checkout itself.
 */
const portableThread = (thread: Thread): Thread => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  userNamed: thread.userNamed,
  ...(thread.agentNamed === undefined ? {} : { agentNamed: thread.agentNamed }),
  model: thread.model,
  mode: thread.mode,
  checkout: { kind: "main", path: effectiveCheckout(thread).path },
  // Labels are this server's own, by id.
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  ...(thread.role === undefined ? {} : { role: thread.role }),
  ...(thread.workspaceId === undefined ? {} : { workspaceId: thread.workspaceId }),
  createdAt: thread.createdAt,
  lastActivityAt: thread.lastActivityAt,
});

const cut = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** How many workers and wakes the orchestrator's first digest names; the rest are counted. */
const NOTE_LISTED = 30;

/**
 * What the orchestrator is told in its first digest on the server it moved to: what came with it,
 * where its repositories are now, and what each worker was doing, since none of them came.
 */
export const handoverNote = (
  bundle: Pick<WorkspaceBundle, "exportedAt" | "workers" | "wakes">,
  places: ReadonlyArray<{ readonly name: string; readonly root: string }>,
): string => {
  const lines = [
    `This workspace was moved to this server from another Gram, where it was exported on ${stamp(bundle.exportedAt)} UTC. Your conversation, your memory, the feature stages and the workers' transcripts came with it. Your session is new: you remember what is in memory and nothing else, so read it before you act.`,
    `The repositories are here now: ${places.map((place) => `${place.name} at ${place.root}`).join("; ")}. Paths from before the move are on the other machine.`,
  ];
  if (bundle.workers.length === 0) {
    lines.push("No worker was open when it moved.");
  } else {
    lines.push(
      "No worker came with it. Each one's transcript is with the finished workers, and its worktree stayed on the other machine, so only what it pushed is reachable from here. To carry one on, spawn a worker on its branch. They were:",
    );
    for (const worker of bundle.workers.slice(0, NOTE_LISTED)) {
      const report =
        worker.lastReport === undefined
          ? "no report"
          : `last report ${worker.lastReport.state}: ${cut(worker.lastReport.summary, 200)}`;
      lines.push(
        `- “${cut(worker.title, 120)}”${worker.feature === undefined ? "" : ` [${cut(worker.feature, 80)}]`}${
          worker.branch === undefined ? "" : `, branch ${cut(worker.branch, 120)}`
        }${worker.prs.length === 0 ? "" : `, ${worker.prs.slice(0, 5).join(", ")}`}, ${report}${
          worker.completedAt === undefined ? "" : ", completed"
        }${
          worker.uncommittedFiles === undefined
            ? ""
            : `, ${worker.uncommittedFiles} changed ${worker.uncommittedFiles === 1 ? "file" : "files"} not committed stayed behind`
        }`,
      );
    }
    if (bundle.workers.length > NOTE_LISTED) {
      lines.push(`- and ${bundle.workers.length - NOTE_LISTED} more.`);
    }
  }
  if (bundle.wakes.length > 0) {
    lines.push(
      "The wakes you had set did not move. Set again the ones that still matter:",
      ...bundle.wakes
        .slice(0, NOTE_LISTED)
        .map((wake) => `- ${stamp(wake.at)} UTC: ${cut(wake.note, 200)}`),
    );
  }
  return lines.join("\n");
};

/** What is wrong with a bundle that its schema can't say, or `undefined`. Pure. */
export const bundleProblem = (bundle: WorkspaceBundle): string | undefined => {
  const { workspace } = bundle.workspace;
  if (!SAFE_ID.test(workspace.id)) return "The bundle's workspace id is not one Gram makes.";
  const projects = new Set<string>(bundle.projects.map((project) => project.id));
  if (projects.size !== bundle.projects.length) return "The bundle names a project twice.";
  if (workspace.projectIds.some((id) => !projects.has(id))) {
    return "The bundle's workspace has a project the bundle doesn't describe.";
  }
  if (!workspace.projectIds.includes(workspace.homeProjectId)) {
    return "The bundle's home project is not one of its workspace's projects.";
  }
  const orchestrator = bundle.orchestrator;
  if (orchestrator !== undefined) {
    const { thread } = orchestrator;
    if (!SAFE_ID.test(thread.id)) return "The bundle's orchestrator id is not one Gram makes.";
    if (thread.role !== "orchestrator" || thread.workspaceId !== workspace.id) {
      return "The bundle's orchestrator is not this workspace's orchestrator.";
    }
    const messages = new Set(orchestrator.messages.map(({ message }) => message.id));
    if (messages.size !== orchestrator.messages.length) {
      return "The bundle's conversation has a message twice.";
    }
    const turns = new Set<string>(orchestrator.turns.map((turn) => turn.id));
    if (turns.size !== orchestrator.turns.length)
      return "The bundle's conversation has a turn twice.";
    if (orchestrator.turns.some((turn) => !SAFE_ID.test(turn.id))) {
      return "A turn id in the bundle is not one Gram makes.";
    }
  }
  const transcripts = [...bundle.archive, ...bundle.workers].map((each) => each.threadId);
  if (transcripts.some((id) => !SAFE_ID.test(id))) {
    return "A thread id in the bundle is not one Gram makes.";
  }
  if (bundle.memory.length > 0) {
    const memory = checkMemorySet(bundle.memory);
    if (!memory.ok) return `The bundle's memory can't be kept: ${memory.problem}`;
  }
  return undefined;
};

export interface WorkspaceTransferShape {
  /**
   * The workspace as a bundle. Refused while its orchestrator is in the middle of a turn, which no
   * bundle can carry; unless told not to, the workspace is paused here first and stays paused.
   */
  exportWorkspace(
    input: ExportWorkspaceInput,
  ): Effect.Effect<WorkspaceBundle, NotFound | InvalidState>;
  /**
   * Takes a bundle in as a workspace of this server and opens its orchestrator. Nothing is written
   * when the bundle can't be read here, a repository has no folder given, the workspace is already
   * here, or nothing here may orchestrate under its charter.
   */
  importWorkspace(
    input: ImportWorkspaceInput,
  ): Effect.Effect<ImportWorkspaceResult, NotFound | InvalidState>;
}

export class WorkspaceTransfer extends Context.Service<WorkspaceTransfer, WorkspaceTransferShape>()(
  "@gram/server/WorkspaceTransfer",
) {
  static readonly layer: Layer.Layer<
    WorkspaceTransfer,
    never,
    | ThreadStore
    | ThreadRuntimes
    | CheckoutService
    | Orchestration
    | OrchestrationMemory
    | ThreadArchive
    | ServerConfig
  > = Layer.effect(
    WorkspaceTransfer,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const orchestration = yield* Orchestration;
      const memory = yield* OrchestrationMemory;
      const archive = yield* ThreadArchive;
      const config = yield* ServerConfig;
      // Absent in a server without git: a bundle then says nothing of remotes or changed files.
      const publisher = Option.getOrUndefined(yield* Effect.serviceOption(GitStatePublisher));
      const proc = Option.getOrUndefined(yield* Effect.serviceOption(Proc));
      const reopener = yield* makeClosedReopener();

      const requireOn = Effect.gen(function* () {
        if (!embeddingOn(yield* store.getSettings)) return yield* refuse(TRANSFER_OFF);
      });

      const remoteOf = (root: string) =>
        proc === undefined
          ? Effect.succeed(undefined)
          : cachedOriginUrl(root).pipe(
              Effect.provideService(Proc, proc),
              Effect.map((url) => (url === undefined ? undefined : shareableRemote(url))),
              Effect.orElseSucceed(() => undefined),
            );

      const workerOf = (thread: Thread, notes: Array<string>) =>
        Effect.gen(function* () {
          const checkout = effectiveCheckout(thread);
          const text = renderClosedThread(thread, yield* store.listMessagesFrom(thread.id, 0));
          const git = publisher === undefined ? undefined : yield* publisher.stateForThread(thread);
          const status = yield* runtimes
            .status(thread.id)
            .pipe(Effect.orElseSucceed((): ThreadStatus => "cold"));
          if (MID_TURN.has(status)) {
            notes.push(
              `“${cut(thread.title, 120)}” was in the middle of a turn; its transcript ends where the export read it.`,
            );
          }
          const prs = [thread.boundPr, ...(thread.extraPrs ?? [])].flatMap((pr) =>
            pr === undefined ? [] : [`${pr.repo}#${pr.number}`],
          );
          return {
            threadId: thread.id,
            title: cut(thread.title, 2_000),
            ...(thread.spawnedBy === undefined
              ? {}
              : { feature: cut(thread.spawnedBy.feature, 2_000) }),
            projectId: thread.projectId,
            ...(checkout.branch === undefined ? {} : { branch: cut(checkout.branch, 2_000) }),
            ...(checkout.base === undefined ? {} : { base: cut(checkout.base, 2_000) }),
            prs: prs.slice(0, 50),
            ...(thread.completedAt === undefined ? {} : { completedAt: thread.completedAt }),
            ...(git !== undefined && git.changedFiles > 0
              ? { uncommittedFiles: git.changedFiles }
              : {}),
            ...(text === undefined ? {} : { transcript: text }),
          } satisfies BundleWorker;
        });

      const snapshot = (workspaceId: WorkspaceState["workspace"]["id"]) =>
        Effect.gen(function* () {
          const notes: Array<string> = [];
          const { paused: _paused, ...state } = yield* store.getWorkspace(workspaceId);
          const { workspace } = state;
          const threads = (yield* store.listThreads).filter(
            (thread) => thread.workspaceId === workspaceId,
          );
          const holder = threads.find(
            (thread) =>
              thread.id === workspace.orchestratorThreadId && thread.role === "orchestrator",
          );
          if (holder !== undefined) {
            const status = yield* runtimes
              .status(holder.id)
              .pipe(Effect.orElseSucceed((): ThreadStatus => "cold"));
            if (MID_TURN.has(status)) {
              return yield* new InvalidState({
                message: `The orchestrator of ${workspace.name} is in the middle of a turn, which can't move with it. Export again once the turn has ended.`,
                threadId: holder.id,
                status,
              });
            }
          }

          const known = yield* store.listProjects;
          const projects: Array<BundleProject> = [];
          for (const id of workspace.projectIds) {
            const project = known.find((each) => each.id === id);
            if (project === undefined) {
              return yield* refuse(
                `A repository of ${workspace.name} is no longer a project here, so the workspace can't be described whole. Edit the workspace first.`,
              );
            }
            const remote = yield* remoteOf(project.root);
            if (remote === undefined) {
              notes.push(
                `${project.name} has no origin a bundle may name; whoever imports it has to know which repository it is.`,
              );
            }
            projects.push({
              id: project.id,
              name: project.name,
              root: project.root,
              ...(remote === undefined ? {} : { remote }),
            });
          }

          let orchestrator: WorkspaceBundle["orchestrator"];
          if (holder !== undefined) {
            const history = yield* store.exportHistory(holder.id);
            const dropped = Math.max(0, history.messages.length - BUNDLE_MESSAGES_MAX);
            if (dropped > 0) {
              notes.push(
                `The orchestrator's conversation is longer than a bundle carries; its ${dropped} oldest messages stayed behind.`,
              );
            }
            const plan = yield* store.getPlan(holder.id);
            orchestrator = {
              thread: portableThread(holder),
              messages: scrubbed(history.messages.slice(dropped)),
              turns: history.turns.slice(-BUNDLE_MESSAGES_MAX),
              ...(plan.plan === undefined ? {} : { plan: plan.plan }),
              ...(plan.turnPlan === undefined ? {} : { turnPlan: plan.turnPlan }),
            };
          } else {
            notes.push("No orchestrator was open, so no conversation is in the bundle.");
          }

          const open = threads
            .filter((thread) => thread.id !== holder?.id && thread.role === undefined)
            .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt);
          if (open.length > BUNDLE_WORKERS_MAX) {
            notes.push(
              `${open.length - BUNDLE_WORKERS_MAX} of the oldest open workers are not in the bundle.`,
            );
          }
          const kept = open.slice(0, BUNDLE_WORKERS_MAX);
          const reports = new Map(
            (yield* store.latestWorkerReports(
              workspaceId,
              kept.map((thread) => thread.id),
            )).map(({ report }) => [report.threadId, report] as const),
          );
          const workers: Array<BundleWorker> = [];
          for (const thread of kept) {
            const worker = yield* workerOf(thread, notes);
            const report = reports.get(thread.id);
            workers.push(
              report === undefined
                ? worker
                : {
                    ...worker,
                    lastReport: {
                      state: report.state,
                      summary: redactText(report.summary),
                      at: report.at,
                    },
                  },
            );
            if (worker.uncommittedFiles !== undefined) {
              notes.push(
                `“${worker.title}” has ${worker.uncommittedFiles} changed ${worker.uncommittedFiles === 1 ? "file" : "files"} not committed. They stay in its worktree on this machine.`,
              );
            }
          }

          const archived: Array<WorkspaceBundle["archive"][number]> = [];
          const listed = yield* archive.list(workspaceId).pipe(Effect.orElseSucceed(() => []));
          for (const entry of listed.slice(0, BUNDLE_WORKERS_MAX)) {
            const text = yield* archive
              .read(workspaceId, entry.threadId)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (text === undefined) {
              notes.push(`The archived transcript of ${entry.threadId} couldn't be read.`);
              continue;
            }
            archived.push({
              threadId: entry.threadId as Thread["id"],
              text,
              archivedAt: entry.archivedAt,
            });
          }

          const files: Array<WorkspaceBundle["memory"][number]> = [];
          const memoryFiles = yield* memory.list(workspaceId).pipe(Effect.orElseSucceed(() => []));
          for (const file of memoryFiles) {
            const content = yield* memory
              .read(workspaceId, file.path)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (content === undefined) {
              notes.push(`The memory file ${file.path} couldn't be read and is not in the bundle.`);
              continue;
            }
            files.push({ path: file.path, content });
          }

          const outbox = decodeOutbox(yield* store.getOutbox(workspaceId));
          const events = yield* store.listOrchestrationEvents(workspaceId, 0);
          const settings = yield* store.getSettings;
          return {
            format: WORKSPACE_BUNDLE_FORMAT,
            app: { version: config.appVersion ?? "0.0.0", schema: SCHEMA },
            exportedAt: yield* Clock.currentTimeMillis,
            workspace: state,
            projects: projects as unknown as WorkspaceBundle["projects"],
            ...(orchestrator === undefined ? {} : { orchestrator }),
            workers,
            archive: archived,
            memory: files,
            featureCards: yield* store.listFeatureCards(workspaceId),
            events: scrubbed(
              events.slice(-BUNDLE_EVENTS_MAX).map(({ at, kind, data }) => ({ at, kind, data })),
            ),
            generation: outbox.generation,
            wakes: [...(outbox.wakes ?? []), ...(outbox.dueWakes ?? [])]
              .toSorted((a, b) => a.at - b.at)
              .slice(0, 200)
              .map((wake) => ({ at: wake.at, note: cut(redactText(wake.note), 2_000) })),
            settings: {
              ...(settings.workspaces === undefined ? {} : { workspaces: settings.workspaces }),
              ...(settings.reviewBots === undefined ? {} : { reviewBots: settings.reviewBots }),
            },
            notes,
          } satisfies WorkspaceBundle;
        });

      const exportWorkspace: WorkspaceTransferShape["exportWorkspace"] = (input) =>
        Effect.gen(function* () {
          yield* requireOn;
          const before = yield* store.getWorkspace(input.workspaceId);
          const pauseHere = input.pause !== false && before.paused === undefined;
          if (pauseHere) yield* orchestration.setPaused(input.workspaceId, true);
          const bundle = yield* snapshot(input.workspaceId).pipe(
            // A refused export moved nothing, so the pause it made goes with it.
            Effect.onError(() =>
              pauseHere
                ? orchestration.setPaused(input.workspaceId, false).pipe(Effect.ignore)
                : Effect.void,
            ),
          );
          yield* store.appendOrchestrationEvent(input.workspaceId, {
            at: bundle.exportedAt,
            kind: "move",
            data: { direction: "exported", paused: pauseHere },
          });
          return bundle;
        });

      /** Each of the workspace's repositories as a project of this server, by its id in the bundle. */
      const placeProjects = (bundle: WorkspaceBundle, places: ImportWorkspaceInput["projects"]) =>
        Effect.gen(function* () {
          const wanted = bundle.projects.filter((project) =>
            bundle.workspace.workspace.projectIds.includes(project.id),
          );
          const missing = wanted.filter((project) => places[project.id] === undefined);
          if (missing.length > 0) {
            return yield* refuse(
              `Say where each of the workspace's repositories is on this server. Missing: ${missing
                .map(
                  (project) =>
                    `${cut(project.name, 80)} [${project.id}]${project.remote === undefined ? "" : ` (${cut(project.remote, 200)})`}`,
                )
                .join(", ")}.`,
            );
          }
          const placed = new Map<ProjectId, Project>();
          const roots = new Set<string>();
          for (const project of wanted) {
            const { project: here } = yield* registerRepo(store, places[project.id]!.root);
            const key = projectRootKey(here.root);
            if (roots.has(key)) {
              return yield* refuse(
                `Two of the workspace's repositories were given the same folder, ${here.root}.`,
              );
            }
            roots.add(key);
            placed.set(project.id, here);
          }
          return placed;
        });

      const importWorkspace: WorkspaceTransferShape["importWorkspace"] = (input) =>
        Effect.gen(function* () {
          yield* requireOn;
          const { bundle } = input;
          if (!bundleReadable(bundle, SCHEMA)) {
            return yield* refuse(
              `This workspace was exported by a newer Gram (${cut(bundle.app.version, 40)}) than this server runs. Update this server, then import it again.`,
            );
          }
          const problem = bundleProblem(bundle);
          if (problem !== undefined) return yield* refuse(problem);
          const source = bundle.workspace;
          const workspaceId = source.workspace.id;
          yield* refuseConnectorEntries(source.charter);
          if ((yield* store.listWorkspaces).some(({ workspace }) => workspace.id === workspaceId)) {
            return yield* refuse("This workspace is already on this server.");
          }
          const opening =
            bundle.orchestrator === undefined
              ? undefined
              : yield* orchestration
                  .orchestratorOpening(source.charter)
                  .pipe(
                    Effect.mapError((error) =>
                      refuse(
                        `This server can't run this workspace's orchestrator. ${error.message}`,
                      ),
                    ),
                  );
          const placed = yield* placeProjects(bundle, input.projects);
          const projectIds = source.workspace.projectIds.map(
            (id) => placed.get(id)!.id,
          ) as unknown as WorkspaceState["workspace"]["projectIds"];
          const home = placed.get(source.workspace.homeProjectId)!;
          const others = [...placed.values()].filter((project) => project.id !== home.id);
          const notes: Array<string> = opening?.note === undefined ? [] : [opening.note];
          const now = yield* Clock.currentTimeMillis;

          // Files first: a memory tree for a workspace the database then refuses is only a folder
          // nothing names, while a workspace without its memory would boot knowing nothing.
          if (bundle.memory.length > 0) {
            yield* memory
              .adopt(workspaceId, bundle.memory)
              .pipe(
                Effect.mapError((error) =>
                  refuse(`The workspace's memory couldn't be written here: ${error.message}`),
                ),
              );
          } else {
            yield* memory.init(workspaceId).pipe(Effect.ignore);
          }
          // Oldest first, so what the archive's caps prune is the oldest.
          const transcripts = [
            ...bundle.archive.toSorted((a, b) => a.archivedAt - b.archivedAt),
            ...bundle.workers
              .toReversed()
              .flatMap((worker) =>
                worker.transcript === undefined
                  ? []
                  : [{ threadId: worker.threadId, text: worker.transcript }],
              ),
          ];
          let archived = 0;
          for (const transcript of transcripts) {
            const written = yield* archive
              .write(workspaceId, transcript.threadId, transcript.text)
              .pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
            if (written) archived++;
            else notes.push(`The transcript of ${transcript.threadId} couldn't be written here.`);
          }

          const note = handoverNote(bundle, [home, ...others]);
          const orchestratorId = bundle.orchestrator?.thread.id;
          yield* orchestration.arrive((taken) => {
            const { orchestratorThreadId: _holder, ...workspace } = source.workspace;
            const { paused: _paused, ...rest } = source;
            const state: WorkspaceState = {
              ...rest,
              workspace: {
                ...workspace,
                name: availableWorkspaceName(source.workspace.name, taken),
                projectIds,
                homeProjectId: home.id,
              },
            };
            const moved = bundle.orchestrator;
            return store.stageMovedWorkspace({
              state,
              ...(moved === undefined || opening === undefined
                ? {}
                : {
                    orchestrator: {
                      thread: {
                        ...portableThread(moved.thread),
                        projectId: home.id,
                        model: opening.model,
                        mode: opening.mode,
                        checkout: { kind: "main", path: home.root },
                        parked: false,
                        ...(others.length === 0
                          ? {}
                          : { additionalDirectories: others.map((project) => project.root) }),
                      },
                      closedAt: now,
                      messages: moved.messages,
                      turns: moved.turns,
                      plan: moved.plan,
                      turnPlan: moved.turnPlan,
                    },
                  }),
              featureCards: bundle.featureCards,
              events: [
                ...bundle.events,
                {
                  at: now,
                  kind: "move",
                  data: {
                    direction: "imported",
                    exportedAt: bundle.exportedAt,
                    from: cut(bundle.app.version, 40),
                  },
                },
              ],
              outbox: encodeOutbox({
                ...emptyOutbox,
                generation: bundle.generation,
                notes: [note],
              }),
            });
          });

          if (input.adoptSettings === true) {
            const { workspaces, reviewBots } = bundle.settings;
            yield* store.updateSettings(
              (settings) => ({
                ...settings,
                ...(workspaces === undefined ? {} : { workspaces }),
                ...(reviewBots === undefined ? {} : { reviewBots }),
              }),
              [
                ...(workspaces === undefined ? [] : [["workspaces"]]),
                ...(reviewBots === undefined ? [] : [["reviewBots"]]),
              ],
            );
          }

          const opened =
            orchestratorId === undefined
              ? ({ orchestrator: "none" } as const)
              : yield* openOrchestrator(orchestratorId);
          return {
            workspace: yield* store.getWorkspace(workspaceId),
            ...opened,
            transcripts: archived,
            notes,
          } satisfies ImportWorkspaceResult;
        });

      /**
       * The staged orchestrator opened as a closed thread is: taken off the closed list and made
       * again under its id with its conversation, its slot claimed and its first digest asked for.
       * One that can't be opened goes back on the list, where the user can reopen it.
       */
      const openOrchestrator = (threadId: Thread["id"]) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const taken = yield* store.takeClosed(threadId);
            if (taken === undefined) {
              return {
                orchestrator: "notOpened",
                problem: "The orchestrator's record could not be read back.",
              } as const;
            }
            const putBack = store.getThread(threadId).pipe(
              Effect.option,
              Effect.flatMap((made) =>
                Option.isSome(made)
                  ? Effect.void
                  : store.rememberClosed(taken.closed.thread, taken.closed.closedAt, []),
              ),
            );
            return yield* restore(reopener.reopenTaken(taken.closed, [])).pipe(
              Effect.onInterrupt(() => putBack),
              Effect.matchEffect({
                onFailure: (error) =>
                  putBack.pipe(
                    Effect.as({
                      orchestrator: "notOpened",
                      orchestratorThreadId: threadId,
                      problem: `${error.message} The workspace and its memory are here; reopen the orchestrator from the closed threads.`,
                    } as const),
                  ),
                onSuccess: (reopened) =>
                  Effect.succeed(
                    "thread" in reopened && reopened.membership === "restored"
                      ? ({ orchestrator: "restored", orchestratorThreadId: threadId } as const)
                      : ({
                          orchestrator: "notOpened",
                          orchestratorThreadId: threadId,
                          problem:
                            "The orchestrator's conversation is here as a thread, and it could not take the workspace's orchestrator slot. Open an orchestrator for the workspace to carry on from its memory.",
                        } as const),
                  ),
              }),
            );
          }),
        );

      return WorkspaceTransfer.of({ exportWorkspace, importWorkspace });
    }),
  );
}
