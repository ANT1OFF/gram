import {
  AppToolError,
  isWaitLink,
  MAX_OPEN_WAITS,
  NotFound,
  plainWaitText,
  type Thread,
  ThreadId,
  WAIT_BODY_MAX,
  WAIT_COPY_MAX,
  WAIT_TITLE_MAX,
  type WaitChange,
  waitEndingOf,
  WaitId,
  type WaitItem,
  WaitKind,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import type { ThreadWaitsShape } from "../waits/service.ts";
import { waitsStaleIn } from "../orchestration/digest-waiting.ts";
import { inputAliases } from "./input.ts";
import { defineAppTool, failed } from "./definition.ts";

/** What `wait_on_user` answers an orchestrator that files a decision, which `ask_user` takes. */
export const WAIT_DECISION_NEEDS_ASK_USER =
  "You're an orchestrator: ask a decision with ask_user, which gives it options, a recommendation " +
  "and an answer path on the board. wait_on_user is for what the user must do outside this " +
  "conversation: a draft to send, a link to review, a step only they can take.";

const waitOnUserFields = {
  kind: WaitKind,
  title: Schema.NonEmptyString.check(Schema.isMaxLength(WAIT_TITLE_MAX)),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WAIT_BODY_MAX))),
  copy: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WAIT_COPY_MAX))),
  link: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(WaitId),
};

const waitOnUserInput = inputAliases(Schema.Struct(waitOnUserFields), {
  body: ["content", "text", "message"],
});

/** How long ago `at` was, as a list row says it: "42m", "3h", "2d". */
export const waitAge = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

const listedChange = (change: WaitChange, now: number) => ({
  change: change.change,
  by: change.by,
  ...(change.thread === undefined ? {} : { byThread: change.thread }),
  age: waitAge(change.at, now),
  ...(change.from === undefined ? {} : { from: change.from }),
});

const homeOf = (thread: Thread) => {
  const stale = waitsStaleIn(thread);
  return {
    threadId: thread.id,
    thread: thread.title,
    ...(stale === "archived" ? { archived: true } : {}),
    ...(stale === "merged" ? { merged: true } : {}),
  };
};

const listedWait = (item: WaitItem, now: number, home?: Thread) => ({
  id: item.id,
  ...(home === undefined ? {} : homeOf(home)),
  kind: item.kind,
  title: item.title,
  state: item.deletedAt !== undefined ? "deleted" : (waitEndingOf(item) ?? "open"),
  source: item.source,
  ...(item.resolvedBy === undefined ? {} : { resolvedBy: item.resolvedBy }),
  ...(item.resolverThread === undefined ? {} : { resolvedByThread: item.resolverThread }),
  ...(item.note === undefined ? {} : { note: item.note }),
  age: waitAge(item.createdAt, now),
  ...(item.history === undefined
    ? {}
    : { history: item.history.map((change) => listedChange(change, now)) }),
});

/** What the wait tools answer a thread that names another it may not manage. */
export const WAIT_NOT_YOUR_WORKER =
  "threadId must be a thread in the workspace you orchestrate; only that workspace's " +
  "orchestrator edits, resolves or reads another thread's Waiting on you.";

/**
 * Whether `caller` may read, edit and resolve `target`'s items: its own, or as the orchestrator
 * holding a workspace, any thread's in that workspace (its workers, live or archived, spawned by it
 * or an orchestrator before it, and threads that joined it). A thread elsewhere is never.
 */
export const managesWaitsOf = (
  threads: Pick<ThreadStoreShape, "getThread">,
  runtimes: Pick<ThreadRuntimesShape, "audienceOf">,
  caller: ThreadId,
  target: ThreadId,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (caller === target) return true;
    const other = yield* threads.getThread(target);
    const self = yield* threads.getThread(caller);
    return (
      other.workspaceId !== undefined &&
      other.workspaceId === self.workspaceId &&
      (yield* runtimes.audienceOf(caller)) === "orchestrator"
    );
  }).pipe(Effect.orElseSucceed(() => false));

const workspaceThreadsOf = (
  threads: Pick<ThreadStoreShape, "getThread" | "listThreads">,
  caller: ThreadId,
): Effect.Effect<ReadonlyArray<Thread>> =>
  Effect.gen(function* () {
    const self = yield* threads.getThread(caller);
    if (self.workspaceId === undefined) return [self];
    const all = yield* threads.listThreads;
    return [
      self,
      ...all.filter((thread) => thread.id !== caller && thread.workspaceId === self.workspaceId),
    ];
  }).pipe(Effect.orElseSucceed(() => []));

const targetOf = (
  tool: string,
  threads: Pick<ThreadStoreShape, "getThread">,
  runtimes: Pick<ThreadRuntimesShape, "audienceOf">,
  caller: ThreadId,
  named: string | undefined,
): Effect.Effect<ThreadId, AppToolError> =>
  named === undefined || named === caller
    ? Effect.succeed(caller)
    : Effect.flatMap(managesWaitsOf(threads, runtimes, caller, ThreadId.make(named)), (owns) =>
        owns
          ? Effect.succeed(ThreadId.make(named))
          : Effect.fail(new AppToolError({ tool, message: WAIT_NOT_YOUR_WORKER })),
      );

/**
 * `wait_on_user`, `resolve_wait` and `list_waits`: the agent's own list
 * of what the user must do outside the conversation, shown in the thread's tray and counted on its
 * sidebar row. *Self* tools for every thread, with no card, and a read. An orchestrator also reads,
 * edits, resolves and deletes the items of every thread in its workspace (`managesWaitsOf`),
 * whoever added them, and lists them all at once. An item anchors to the reply it was added in, as
 * a `data-wait` chip there, which is where Jump to goes; another thread's edit stays there.
 */
export const waitAppTools = (
  waits: ThreadWaitsShape,
  runtimes: Pick<ThreadRuntimesShape, "audienceOf">,
  threads: Pick<ThreadStoreShape, "getThread" | "listThreads">,
) =>
  [false, true].flatMap((orchestrator) => [
    defineAppTool({
      descriptor: {
        name: "wait_on_user",
        class: "self",
        description: `Use \`content\` for the body (\`body\`, \`text\` and \`message\` are aliases). Add to the user's Waiting on you list what they must act on outside this conversation: a \`draft\` to send elsewhere (Teams, mail, a PR), a \`review\` of a link, a \`decision\` you can't make, an \`action\` only they can take. Not for status. Write a draft in your reply too; \`copy\` is the exact text Copy copies, else the reply's quoted or fenced block. \`link\` is an http(s) URL to open. Pass an open item's \`id\` to update it rather than add another${orchestrator ? ", with a `threadId` to edit another thread's" : ""}. \`resolve_wait\` takes it off. At most ${MAX_OPEN_WAITS} open at once.`,
      },
      audience: orchestrator ? ["orchestrator"] : ["plain", "worker"],
      input: orchestrator
        ? inputAliases(
            Schema.Struct({
              ...waitOnUserFields,
              threadId: Schema.optionalKey(Schema.NonEmptyString),
            }),
            { body: ["content", "text", "message"] },
          )
        : waitOnUserInput,
      handle: (caller, input) =>
        Effect.gen(function* () {
          const tool = "wait_on_user";
          const named = "threadId" in input ? (input.threadId as string | undefined) : undefined;
          const threadId = yield* targetOf(tool, threads, runtimes, caller, named);
          const editor = threadId === caller ? undefined : caller;
          if (editor !== undefined && input.id === undefined) {
            return yield* new AppToolError({
              tool,
              message:
                "pass the id of the item to edit with threadId; add your own items without threadId",
            });
          }
          if (input.kind === "decision" && orchestrator && editor === undefined) {
            return yield* new AppToolError({ tool, message: WAIT_DECISION_NEEDS_ASK_USER });
          }
          const title = plainWaitText(input.title);
          if (title === "") return yield* new AppToolError({ tool, message: "title is blank" });
          const link = input.link?.trim();
          if (link !== undefined && !isWaitLink(link)) {
            return yield* new AppToolError({ tool, message: "link must be an http(s) URL" });
          }
          const body =
            input.body === undefined ? undefined : plainWaitText(input.body, true).trim();
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
              editor,
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
                      message:
                        editor === undefined
                          ? `no open item ${input.id} in this thread; leave out id to add one`
                          : `no open item ${input.id} in thread ${threadId}`,
                    }),
                  ),
              }),
            );
          return {
            id: put.item.id,
            ...(editor === undefined ? {} : { threadId }),
            open: put.open,
          };
        }).pipe(
          Effect.mapError((e) => (e instanceof AppToolError ? e : failed("wait_on_user")(e))),
        ),
    }),
    defineAppTool({
      descriptor: {
        name: "resolve_wait",
        class: "self",
        description:
          "Take an item off the user's Waiting on you, with an optional `note` on why. `ending`: " +
          '"done" (default), "withdrawn" once it no longer makes sense, or "deleted", off every list.' +
          (orchestrator
            ? " Pass a `threadId` for any thread's item in your workspace; that defaults to withdrawn."
            : ""),
      },
      audience: orchestrator ? ["orchestrator"] : ["plain", "worker"],
      rejectExcessProperties: true,
      input: Schema.Struct({
        id: WaitId,
        note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WAIT_BODY_MAX))),
        ending: Schema.optionalKey(Schema.Literals(["done", "withdrawn", "deleted"])),
        ...(orchestrator ? { threadId: Schema.optionalKey(Schema.NonEmptyString) } : {}),
      }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const { id, note, ending } = input;
          const named = "threadId" in input ? (input.threadId as string | undefined) : undefined;
          const target = yield* targetOf("resolve_wait", threads, runtimes, caller, named);
          const plainNote = note === undefined ? undefined : plainWaitText(note);
          const said = plainNote === undefined || plainNote === "" ? {} : { note: plainNote };
          const by = target === caller ? {} : { thread: caller };
          const at = Date.now();
          const { item } =
            ending === "deleted"
              ? yield* waits.remove(target, id, { by: "agent", at, ...by, ...said })
              : yield* waits.resolve(target, id, {
                  by: "agent",
                  at,
                  ending: ending ?? (target === caller ? "done" : "withdrawn"),
                  ...by,
                  ...said,
                });
          return {
            id,
            ...(target === caller ? {} : { threadId: target }),
            resolvedBy: item.resolvedBy,
            ending: waitEndingOf(item),
            ...(item.deletedAt === undefined ? {} : { deleted: true }),
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
        description: `List the user's Waiting on you items ${orchestrator ? "across your workspace, each with its thread, `archived` or `merged` if likely stale, or one thread's by `threadId`" : "in this thread"}: the open ones, with \`state: "all"\` those resolved in the last 30 days too, or \`"deleted"\`; each with its \`state\`, resolver, age and edits. Read it after a compaction or a fresh session rather than guess.`,
      },
      audience: orchestrator ? ["orchestrator"] : ["plain", "worker"],
      rejectExcessProperties: true,
      input: Schema.Struct({
        state: Schema.optionalKey(Schema.Literals(["open", "all", "deleted"])),
        ...(orchestrator ? { threadId: Schema.optionalKey(Schema.NonEmptyString) } : {}),
      }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const which = input.state ?? "open";
          const named = "threadId" in input ? (input.threadId as string | undefined) : undefined;
          const now = Date.now();
          if (!orchestrator || named !== undefined) {
            const target = yield* targetOf("list_waits", threads, runtimes, caller, named);
            const items = yield* waits.listForAgent(target, which, target === caller);
            return { waits: items.map((item) => listedWait(item, now)) };
          }
          const homes = yield* workspaceThreadsOf(threads, caller);
          const rows = yield* Effect.forEach(homes, (thread) =>
            waits
              .listForAgent(thread.id, which, thread.id === caller)
              .pipe(Effect.map((items) => items.map((item) => ({ item, thread })))),
          );
          return {
            waits: rows
              .flat()
              .toSorted((a, b) => a.item.createdAt - b.item.createdAt)
              .map(({ item, thread }) => listedWait(item, now, thread)),
          };
        }),
    }),
  ]);
