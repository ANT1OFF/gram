import {
  AppToolError,
  isWaitLink,
  MAX_OPEN_WAITS,
  NotFound,
  plainWaitText,
  WAIT_BODY_MAX,
  WAIT_COPY_MAX,
  WAIT_TITLE_MAX,
  type ThreadId,
  WaitId,
  waitEndingOf,
  WaitKind,
  WaitListState,
  type WaitItem,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import type { ThreadWaitsShape } from "../waits/service.ts";
import { inputAliases } from "./input.ts";
import { defineAppTool, failed } from "./definition.ts";

/** What `wait_on_user` answers an orchestrator that files a decision, which `ask_user` takes. */
export const WAIT_DECISION_NEEDS_ASK_USER =
  "You're an orchestrator: ask a decision with ask_user, which gives it options, a recommendation " +
  "and an answer path on the board. wait_on_user is for what the user must do outside this " +
  "conversation: a draft to send, a link to review, a step only they can take.";

const waitOnUserInput = inputAliases(
  Schema.Struct({
    kind: WaitKind,
    title: Schema.NonEmptyString.check(Schema.isMaxLength(WAIT_TITLE_MAX)),
    body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WAIT_BODY_MAX))),
    copy: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WAIT_COPY_MAX))),
    link: Schema.optionalKey(Schema.String),
    id: Schema.optionalKey(WaitId),
  }),
  { body: ["content", "text", "message"] },
);

/** How long ago `at` was, as a list row says it: "42m", "3h", "2d". */
export const waitAge = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

const listedWait = (item: WaitItem, now: number) => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  state: waitEndingOf(item) ?? "open",
  source: item.source,
  ...(item.resolvedBy === undefined ? {} : { resolvedBy: item.resolvedBy }),
  ...(item.resolverThread === undefined ? {} : { resolvedByThread: item.resolverThread }),
  ...(item.note === undefined ? {} : { note: item.note }),
  age: waitAge(item.createdAt, now),
});

/** What `resolve_wait` and `list_waits` answer a thread that names another it doesn't own. */
export const WAIT_NOT_YOUR_WORKER =
  "threadId must be a worker you started as this workspace's orchestrator; only its own " +
  "orchestrator resolves or reads another thread's Waiting on you.";

/** Whether `caller` may resolve and read `target`'s items: its own orchestrator, in its workspace. */
export const ownsWaitsOf = (
  threads: Pick<ThreadStoreShape, "getThread">,
  runtimes: Pick<ThreadRuntimesShape, "audienceOf">,
  caller: ThreadId,
  target: ThreadId,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (caller === target) return true;
    const worker = yield* threads.getThread(target);
    const self = yield* threads.getThread(caller);
    return (
      worker.spawnedBy?.threadId === caller &&
      worker.workspaceId !== undefined &&
      worker.workspaceId === self.workspaceId &&
      (yield* runtimes.audienceOf(caller)) === "orchestrator"
    );
  }).pipe(Effect.orElseSucceed(() => false));

const targetOf = (
  tool: string,
  threads: Pick<ThreadStoreShape, "getThread">,
  runtimes: Pick<ThreadRuntimesShape, "audienceOf">,
  caller: ThreadId,
  named: string | undefined,
): Effect.Effect<ThreadId, AppToolError> =>
  named === undefined || named === caller
    ? Effect.succeed(caller)
    : Effect.flatMap(ownsWaitsOf(threads, runtimes, caller, named as ThreadId), (owns) =>
        owns
          ? Effect.succeed(named as ThreadId)
          : Effect.fail(new AppToolError({ tool, message: WAIT_NOT_YOUR_WORKER })),
      );

/**
 * `wait_on_user`, `resolve_wait` and `list_waits`: the agent's own list
 * of what the user must do outside the conversation, shown in the thread's tray and counted on its
 * sidebar row. *Self* tools for every thread, with no card, and a read; an orchestrator also
 * resolves and reads its own workers' (`ownsWaitsOf`). An item anchors to the reply it was added
 * in, as a `data-wait` chip there, which is where Jump to goes.
 */
export const waitAppTools = (
  waits: ThreadWaitsShape,
  runtimes: Pick<ThreadRuntimesShape, "audienceOf">,
  threads: Pick<ThreadStoreShape, "getThread">,
) => [
  defineAppTool({
    descriptor: {
      name: "wait_on_user",
      class: "self",
      description: `Use \`content\` for the body (\`body\`, \`text\` and \`message\` are aliases). Add to the user's Waiting on you list what they must act on outside this conversation: a \`draft\` to send elsewhere (Teams, mail, a PR), a \`review\` of a link, a \`decision\` you can't make, an \`action\` only they can take. Not for status. Write a draft in your reply too; \`copy\` is the exact text Copy copies, else the reply's quoted or fenced block. \`link\` is an http(s) URL to open. Pass an open item's \`id\` to update it rather than add another. \`resolve_wait\` takes it off. At most ${MAX_OPEN_WAITS} open at once.`,
    },
    input: waitOnUserInput,
    handle: (threadId, input) =>
      Effect.gen(function* () {
        const tool = "wait_on_user";
        if (
          input.kind === "decision" &&
          (yield* runtimes.audienceOf(threadId)) === "orchestrator"
        ) {
          return yield* new AppToolError({ tool, message: WAIT_DECISION_NEEDS_ASK_USER });
        }
        const title = plainWaitText(input.title);
        if (title === "") return yield* new AppToolError({ tool, message: "title is blank" });
        const link = input.link?.trim();
        if (link !== undefined && !isWaitLink(link)) {
          return yield* new AppToolError({ tool, message: "link must be an http(s) URL" });
        }
        const body = input.body === undefined ? undefined : plainWaitText(input.body, true).trim();
        const copy = input.copy === undefined ? undefined : plainWaitText(input.copy, true);
        const put = yield* waits
          .put(
            threadId,
            {
              kind: input.kind,
              title,
              ...(body === undefined || body === "" ? {} : { body }),
              ...(copy === undefined || copy.trim() === "" ? {} : { copy }),
              ...(link === undefined ? {} : { link }),
              ...(input.id === undefined ? {} : { id: input.id }),
            },
            "agent",
          )
          .pipe(
            Effect.catchTags({
              WaitsFull: ({ open }) =>
                Effect.fail(
                  new AppToolError({
                    tool,
                    message: `${open} items already wait on the user. Resolve one with resolve_wait, or update one by passing its id.`,
                  }),
                ),
              NotFound: () =>
                Effect.fail(
                  new AppToolError({
                    tool,
                    message: `no open item ${input.id} in this thread; leave out id to add one`,
                  }),
                ),
            }),
          );
        return { id: put.item.id, open: put.open };
      }).pipe(Effect.mapError((e) => (e instanceof AppToolError ? e : failed("wait_on_user")(e)))),
  }),
  ...[false, true].flatMap((orchestrator) => [
    defineAppTool({
      descriptor: {
        name: "resolve_wait",
        class: "self",
        description:
          "Take an item off the user's Waiting on you, with an optional `note` on why. `ending`: " +
          '"done" (default) or "withdrawn" once it no longer makes sense.' +
          (orchestrator ? " Pass a worker's `threadId` to withdraw that worker's item." : ""),
      },
      audience: orchestrator ? ["orchestrator"] : ["plain", "worker"],
      rejectExcessProperties: true,
      input: Schema.Struct({
        id: WaitId,
        note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WAIT_BODY_MAX))),
        ending: Schema.optionalKey(Schema.Literals(["done", "withdrawn"])),
        ...(orchestrator ? { threadId: Schema.optionalKey(Schema.NonEmptyString) } : {}),
      }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const { id, note, ending } = input;
          const named = "threadId" in input ? (input.threadId as string | undefined) : undefined;
          const target = yield* targetOf("resolve_wait", threads, runtimes, caller, named);
          const plainNote = note === undefined ? undefined : plainWaitText(note);
          const { item } = yield* waits.resolve(target, id, {
            by: "agent",
            at: Date.now(),
            ending: ending ?? (target === caller ? "done" : "withdrawn"),
            ...(target === caller ? {} : { thread: caller }),
            ...(plainNote === undefined || plainNote === "" ? {} : { note: plainNote }),
          });
          return {
            id,
            ...(target === caller ? {} : { threadId: target }),
            resolvedBy: item.resolvedBy,
            ending: waitEndingOf(item),
            ...(item.resolverThread === undefined ? {} : { resolvedByThread: item.resolverThread }),
          };
        }).pipe(
          Effect.mapError((e) =>
            e instanceof AppToolError
              ? e
              : e instanceof NotFound
                ? new AppToolError({ tool: "resolve_wait", message: `unknown item ${input.id}` })
                : failed("resolve_wait")(e),
          ),
        ),
    }),
    defineAppTool({
      descriptor: {
        name: "list_waits",
        class: "read",
        description: `List the user's Waiting on you items ${orchestrator ? "here, or a worker's by `threadId`" : "in this thread"}: the open ones, or with \`state: "all"\` those resolved in the last 30 days too, each with id, kind, title, source, resolver, \`state\` (open, done, dismissed by the user, withdrawn) and age. Read it after a compaction or a fresh session rather than guess.`,
      },
      audience: orchestrator ? ["orchestrator"] : ["plain", "worker"],
      rejectExcessProperties: true,
      input: Schema.Struct({
        state: Schema.optionalKey(WaitListState),
        ...(orchestrator ? { threadId: Schema.optionalKey(Schema.NonEmptyString) } : {}),
      }),
      handle: (caller, input) =>
        targetOf(
          "list_waits",
          threads,
          runtimes,
          caller,
          "threadId" in input ? (input.threadId as string | undefined) : undefined,
        ).pipe(
          Effect.flatMap((target) =>
            waits.listForAgent(target, input.state ?? "open", target === caller),
          ),
          Effect.map((items) => {
            const now = Date.now();
            return { waits: items.map((item) => listedWait(item, now)) };
          }),
        ),
    }),
  ]),
];
