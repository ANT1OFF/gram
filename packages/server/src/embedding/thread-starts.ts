// `POST /embed/v1/thread-starts`: a thread a person starts in one or more repositories, asked for
// by the platform the server is embedded in on behalf of a person it signed in. It is how a
// person's own API or MCP client starts work in code without a browser, as New task would: a new
// worktree in the first repository, one on the same branch in each other, and the person's first
// message.
//
//   { "person": { "id", "name"? }, "key", "repositories": ["owner/name" | git URL, ...],
//     "text", "title"?, "branch"?, "model"?: { "agent", "model" }, "mode"?: PermissionMode }
//     → 200 { "threadId", "created", "branch" }   made now, or the thread this key made before
//       409 { "error" } one that can't start now (no machine, a repository that refuses)
//       400 a body that isn't one
//
// The repositories are cloned as `projects.clone` clones them: on a server that runs no work
// itself, filed as origins the person's machine clones. The thread is placed as one the person
// started: on their own machine where machines are started for one person, and refused, saying
// so, while they have none running. It is recorded as theirs. `key` names the start: sent again,
// it answers the thread it made.
//
// The platform is trusted to say who the person is, as for `thread-messages`: it proves itself
// with the embed token, never a cookie.

import {
  cloneFolderOf,
  type CheckoutRequest,
  ModelRef,
  parseRepoRemote,
  type PermissionMode,
  type Project,
  type RepoRemote,
  ThreadId,
} from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { ServerConfig } from "../config.ts";
import { cloneRepo } from "../fs/clone.ts";
import { RoutedFor } from "../host/ownership.ts";
import type { Actor } from "../http/fronted-identity.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { actorEventsOf } from "../rpc/actor-guard.ts";
import { makeThreadCreator, prepareWithOthers } from "../runtime/create-in-checkout.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { fileOrigin } from "../thread-profiles/repositories.ts";
import { answer, EmbedInbound, refusal } from "./inbound.ts";
import { ActingPerson } from "./person.ts";
import { THREAD_MESSAGE_MAX } from "./thread-messages.ts";

/** The most repositories one start names, as a profile's workplace takes them. */
export const THREAD_START_REPOSITORIES_MAX = 8;

const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const PERSON = /^[A-Za-z0-9_.:@|-]{1,200}$/;
/** A branch name git takes, without the spellings that read as an option or a range. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

const decodeModel = Schema.decodeUnknownOption(ModelRef);

/**
 * The permission modes a start may ask for: the ones New task offers. `dontAsk` is not one of them,
 * since nothing can ask in it and an outward gate doesn't hold there.
 */
export const THREAD_START_MODES: ReadonlyArray<PermissionMode> = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
];

/** The person a call names, or why the body doesn't name one. */
export const personOf = (value: unknown): Actor | string => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "`person` is the person the platform signed in, with their `id`";
  const { id, name } = value as Record<string, unknown>;
  if (typeof id !== "string" || !PERSON.test(id)) return "`person.id` is a person's id";
  if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.length > 200))
    return "`person.name` is 1 to 200 characters";
  return { id, name: typeof name === "string" ? name.trim() : id, role: "member" };
};

/**
 * The thread a person's start makes: the same for the same person and key, so a start sent again
 * finds the one it made, and another person's key never names it.
 */
export const threadIdOfStart = (person: string, key: string): ThreadId => {
  const hex = createHash("sha256").update(`thread-start\0${person}\0${key}`).digest("hex");
  // A version 4 shaped UUID, as every other thread id is.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return Schema.decodeSync(ThreadId)(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
};

/** A GitHub repository's https address: the spelling a profile's repositories use. */
const originUrl = (remote: RepoRemote): string =>
  remote.kind === "github" ? `https://github.com/${remote.owner}/${remote.repo}` : remote.url;

/** Serves the path; provides nothing. */
export const ThreadStartsInboundLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const checkouts = yield* CheckoutService;
    const proc = yield* Proc;
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    const creator = makeThreadCreator({ store, checkouts, runtimes });

    /** The project a repository is worked in here, cloned (or filed) the first time. */
    const projectOf = (remote: RepoRemote): Effect.Effect<Project, { readonly message: string }> =>
      config?.headless === true
        ? fileOrigin(proc, config.dataDir, originUrl(remote)).pipe(
            Effect.flatMap((filed) => store.ensureProject({ root: filed.path, name: filed.name })),
          )
        : store.getSettings.pipe(
            Effect.flatMap((settings) =>
              cloneRepo(store, {
                remote: originUrl(remote),
                cloneFolder: cloneFolderOf(settings),
              }),
            ),
            Effect.provideService(Proc, proc),
          );

    yield* inbound.route("POST", "thread-starts", (body) =>
      Effect.gen(function* () {
        const person = personOf(body?.["person"]);
        if (typeof person === "string") return refusal(400, person);
        const key = body?.["key"];
        if (typeof key !== "string" || !KEY.test(key))
          return refusal(400, "`key` is 1 to 128 letters, digits, `_` or `-`");
        const text = body?.["text"];
        if (typeof text !== "string" || text.trim() === "" || text.length > THREAD_MESSAGE_MAX)
          return refusal(400, `\`text\` is 1 to ${THREAD_MESSAGE_MAX} characters`);
        const title = body?.["title"];
        if (title !== undefined && (typeof title !== "string" || title.trim() === ""))
          return refusal(400, "`title` is the thread's name");
        const branchAsked = body?.["branch"];
        if (
          branchAsked !== undefined &&
          (typeof branchAsked !== "string" || !BRANCH.test(branchAsked))
        )
          return refusal(400, "`branch` is a branch name");
        const modelAsked = body?.["model"];
        const model = modelAsked === undefined ? undefined : decodeModel(modelAsked);
        if (model !== undefined && Option.isNone(model))
          return refusal(400, "`model` is `{ agent, model }`");
        const mode = body?.["mode"];
        if (mode !== undefined && !THREAD_START_MODES.includes(mode as PermissionMode))
          return refusal(400, `\`mode\` is one of ${THREAD_START_MODES.join(", ")}`);
        const listed = body?.["repositories"];
        if (
          !Array.isArray(listed) ||
          listed.length === 0 ||
          listed.length > THREAD_START_REPOSITORIES_MAX
        )
          return refusal(
            400,
            `\`repositories\` names 1 to ${THREAD_START_REPOSITORIES_MAX} repositories, the one it works in first`,
          );
        const remotes: Array<RepoRemote> = [];
        for (const each of listed) {
          const parsed = typeof each === "string" ? parseRepoRemote(each.trim()) : undefined;
          if (parsed === undefined || "error" in parsed)
            return refusal(
              400,
              `${typeof each === "string" ? each : "A repository"} isn't owner/name or a git URL`,
            );
          remotes.push(parsed);
        }

        const id = threadIdOfStart(person.id, key);
        // Sent again, it answers the thread it made.
        const before = yield* store.getThread(id).pipe(Effect.option);
        if (Option.isSome(before))
          return answer({
            threadId: id,
            created: false,
            ...(before.value.checkout.branch === undefined
              ? {}
              : { branch: before.value.checkout.branch }),
          });

        const start = Effect.gen(function* () {
          const projects: Array<Project> = [];
          for (const remote of remotes) {
            const project = yield* projectOf(remote);
            if (!projects.some((known) => known.root === project.root)) projects.push(project);
          }
          const [own, ...others] = projects;
          const branch = branchAsked ?? `thread/${id.slice(0, 8)}`;
          const request: CheckoutRequest = { kind: "newWorktree", branch };
          const place = yield* prepareWithOthers(
            { prepare: creator.prepare, discard: checkouts.discard },
            request,
            own!.root,
            others.map((other) => other.root),
          );
          const thread = yield* runtimes
            .create({
              id,
              projectRoot: own!.root,
              checkout: place.checkout,
              ...(place.extraCheckouts.length === 0
                ? {}
                : { extraCheckouts: place.extraCheckouts }),
              ...(place.additionalDirectories.length === 0
                ? {}
                : { additionalDirectories: place.additionalDirectories }),
              ...(model === undefined ? {} : { model: model.value }),
              ...(mode === undefined ? {} : { mode: mode as PermissionMode }),
              ...(typeof title === "string" ? { title: title.trim() } : {}),
              input: { text },
            })
            .pipe(
              Effect.onError(() =>
                Effect.forEach([place.checkout, ...place.extraCheckouts], checkouts.discard, {
                  discard: true,
                }),
              ),
            );
          yield* store.appendActorEvents(
            actorEventsOf(
              person,
              "thread.create",
              { projectRoot: own!.root, repositories: listed },
              Date.now(),
              thread,
            ),
          );
          return answer({ threadId: thread.id, created: true, branch });
        });
        return yield* start.pipe(
          Effect.provideService(ActingPerson, person.id),
          Effect.provideService(RoutedFor, { person: person.id }),
          Effect.catch((error: { readonly message?: string }) =>
            Effect.succeed(refusal(409, error.message ?? "the thread couldn't start now")),
          ),
        );
      }),
    );
  }),
);
