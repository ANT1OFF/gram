// `POST /threads/send-check` and `POST /threads/send`: New task sending a task to a hosted
// workspace (docs/design/mocks/hosted-send-and-move, v1, board 1). The check answers where work
// may go and what New task's three checks need: whether the server reaches the repository (asked
// of it, `SentWorkPortShape.check`), whether what the worker starts from is pushed, and what stays
// uncommitted here. The send makes the task the workspace orchestrator's worker on that server
// (`sendWorker`), as `send_worker` would, by the person's own say. Only the local app reaches them
// (`http/remote-access.ts`); while the hosted features setting is off they answer as a path that
// isn't there.

import { embeddingOn, type ProjectId, type WorkspaceId } from "@gram/contracts";
import { git, Proc } from "@gram/git";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SentWorkPort } from "../embedding/sent-work-port.ts";
import { authTarget } from "../http/auth-target.ts";
import { THREAD_SEND_CHECK_PATH, THREAD_SEND_PATH } from "../http/remote-access.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { repositoryOf, sendWorker, targetName } from "./sent-workers.ts";
import { Orchestration } from "./service.ts";

export { THREAD_SEND_CHECK_PATH, THREAD_SEND_PATH };

const BODY_MAX = 64 * 1024;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Target = Schema.Struct({
  origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  workspaceId: Id,
});

export const SendCheckInput = Schema.Struct({
  workspaceId: Id,
  projectId: Id,
  /** The hosted workspace picked: the server is asked whether it reaches the repository. */
  target: Schema.optionalKey(Target),
});

export const SendInput = Schema.Struct({
  workspaceId: Id,
  projectId: Id,
  target: Target,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  /** New task's draft id: a send made again with it answers the worker it made. */
  clientRequestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
});

/** What the worker starts from, and what stays here. Read from this checkout, never fetched. */
export interface LocalChecks {
  /** The branch checked out here; undefined when detached. */
  readonly current?: string;
  /** The remote's default branch, as last fetched: what a thread there starts from. */
  readonly base?: { readonly branch: string; readonly sha: string };
  /** Commits checked out here that the base there doesn't have. */
  readonly ahead: number;
  readonly uncommitted: { readonly count: number; readonly first?: string };
}

const raw = (root: string, args: ReadonlyArray<string>) =>
  git(root, args, { timeoutMs: 5_000 }).pipe(
    Effect.map((each) => (each.status === 0 ? each.stdout : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
const out = (root: string, args: ReadonlyArray<string>) =>
  raw(root, args).pipe(Effect.map((text) => text?.trim()));

/** The base and the changes of a project's checkout. */
export const localChecks = (root: string): Effect.Effect<LocalChecks, never, Proc> =>
  Effect.gen(function* () {
    const current = yield* out(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const head = yield* out(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
    let branch = head?.startsWith("origin/") === true ? head.slice("origin/".length) : undefined;
    for (const guess of ["main", "master"]) {
      if (branch !== undefined) break;
      if (
        (yield* out(root, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${guess}`])) !==
        undefined
      )
        branch = guess;
    }
    const sha =
      branch === undefined
        ? undefined
        : yield* out(root, ["rev-parse", "--short", `refs/remotes/origin/${branch}`]);
    const ahead =
      branch === undefined || sha === undefined
        ? 0
        : Number(
            (yield* out(root, ["rev-list", "--count", `refs/remotes/origin/${branch}..HEAD`])) ?? 0,
          );
    // Each line is two status letters and a space before the path: never trimmed.
    const status = (yield* raw(root, ["status", "--porcelain"])) ?? "";
    const lines = status.split("\n").filter((line) => line.length > 3);
    return {
      ...(current === undefined || current === "" ? {} : { current }),
      ...(branch === undefined || sha === undefined ? {} : { base: { branch, sha } }),
      ahead: Number.isFinite(ahead) ? ahead : 0,
      uncommitted: {
        count: lines.length,
        ...(lines[0] === undefined ? {} : { first: lines[0].slice(3).trim() }),
      },
    };
  });

const refuse = (message: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });
const notThere = HttpServerResponse.text("not found", { status: 404 });

/** The body as JSON, or the response that refuses it. */
const jsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // A form or a plain-text post from another page is never one of these.
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
    return { refused: refuse("Send the body as application/json.", 415) };
  const text = yield* request.text.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(BODY_MAX)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (text === undefined) return { refused: refuse("The body couldn't be read.", 413) };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { refused: refuse("The body is not JSON.", 400) };
  }
  return { value: json };
});

const NOT_ONE = "That isn't a request New task sends.";

/** The workspace's project, by id, with the workspace's orchestrator. */
const projectIn = (store: ThreadStoreShape, workspaceId: string, projectId: string) =>
  Effect.gen(function* () {
    const state = yield* store.getWorkspace(workspaceId as WorkspaceId).pipe(Effect.option);
    if (Option.isNone(state)) return "There is no such workspace here." as const;
    if (!state.value.workspace.projectIds.includes(projectId as ProjectId))
      return "That project isn't one of this workspace's." as const;
    const project = (yield* store.listProjects).find((each) => each.id === projectId);
    if (project === undefined) return "That project isn't one of this workspace's." as const;
    return { state: state.value, project };
  });

/** The two routes on the server's router, under its auth middleware. */
export const SentWorkRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const port = yield* SentWorkPort;
    const proc = yield* Proc;
    const runtimes = yield* ThreadRuntimes;
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const on = store.getSettings.pipe(
      Effect.map(embeddingOn),
      Effect.orElseSucceed(() => false),
    );
    const guard = (path: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Only under its one spelling: the checks above this route match the path exactly.
        if (authTarget(request.url)?.path !== path) return notThere;
        if (!(yield* on) || !port.available || orchestration === undefined) return notThere;
        if (request.method !== "POST")
          return HttpServerResponse.text("method not allowed", {
            status: 405,
            headers: { allow: "POST" },
          });
        return undefined;
      });

    const check = Effect.gen(function* () {
      const refused = yield* guard(THREAD_SEND_CHECK_PATH);
      if (refused !== undefined) return refused;
      const read = yield* jsonBody;
      if (read.refused !== undefined) return read.refused;
      const decoded = Schema.decodeUnknownOption(SendCheckInput)(read.value);
      if (Option.isNone(decoded)) return refuse(NOT_ONE, 400);
      const input = decoded.value;
      const found = yield* projectIn(store, input.workspaceId, input.projectId);
      if (typeof found === "string") return refuse(found, 404);
      const [listed, repository, local] = yield* Effect.all(
        [port.targets(), repositoryOf(found.project.root), localChecks(found.project.root)],
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(Proc, proc));
      const targets = listed.ok
        ? listed.targets.map((target) => ({ ...target, name: targetName(target) }))
        : [];
      const picked =
        input.target === undefined
          ? undefined
          : targets.find(
              (each) =>
                each.origin === input.target?.origin &&
                each.workspaceId === input.target.workspaceId,
            );
      const reach =
        picked === undefined || repository === undefined
          ? undefined
          : yield* port.check(picked.origin, picked.workspaceId, [repository]);
      return HttpServerResponse.jsonUnsafe({
        targets,
        ...(listed.ok ? {} : { unlisted: listed.why }),
        ...(repository === undefined ? {} : { repository }),
        orchestrator: found.state.workspace.orchestratorThreadId !== undefined,
        local,
        ...(reach === undefined
          ? {}
          : reach.ok
            ? { reach: reach.reach.items[0] ?? { repository, reach: "unknown" } }
            : { reach: { repository, reach: "unknown", reason: reach.why } }),
        ...(reach?.ok === true && reach.reach.model !== undefined
          ? { model: reach.reach.model }
          : {}),
      });
    });

    const send = Effect.gen(function* () {
      const refused = yield* guard(THREAD_SEND_PATH);
      if (refused !== undefined || orchestration === undefined) return refused ?? notThere;
      const read = yield* jsonBody;
      if (read.refused !== undefined) return read.refused;
      const decoded = Schema.decodeUnknownOption(SendInput)(read.value);
      if (Option.isNone(decoded)) return refuse(NOT_ONE, 400);
      const input = decoded.value;
      const found = yield* projectIn(store, input.workspaceId, input.projectId);
      if (typeof found === "string") return refuse(found, 404);
      const orchestrator = found.state.workspace.orchestratorThreadId;
      if (orchestrator === undefined)
        return refuse(
          "This workspace has no orchestrator yet to report to. Start a task here first.",
          409,
        );
      const text = input.text.trim();
      const title = (text.split("\n")[0] ?? text).trim().slice(0, 80);
      return yield* sendWorker(
        { orchestration, store, runtimes, port, proc },
        orchestrator,
        {
          project: found.project.id,
          title: title === "" ? "Sent task" : title,
          feature: title === "" ? "Sent task" : title,
          brief: text,
          target: input.target,
          clientRequestId: input.clientRequestId,
        },
        "person",
      ).pipe(
        Effect.map((sent) => HttpServerResponse.jsonUnsafe(sent)),
        Effect.catch((error) => Effect.succeed(refuse(error.message, 409))),
      );
    });

    return Layer.mergeAll(
      HttpRouter.add("*", THREAD_SEND_CHECK_PATH, () => check),
      HttpRouter.add("*", THREAD_SEND_PATH, () => send),
    );
  }),
);
