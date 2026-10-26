import {
  AppToolError,
  isWaitLink,
  MAX_OPEN_WAITS,
  NotFound,
  plainWaitText,
  WAIT_BODY_MAX,
  WAIT_COPY_MAX,
  WAIT_TITLE_MAX,
  WaitId,
  waitIsOpen,
  WaitKind,
  WaitListState,
  type WaitItem,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

/** One row of `list_waits`. */
const listedWait = (item: WaitItem, now: number) => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  state: waitIsOpen(item) ? "open" : "done",
  source: item.source,
  ...(item.resolvedBy === undefined ? {} : { resolvedBy: item.resolvedBy }),
  ...(item.note === undefined ? {} : { note: item.note }),
  age: waitAge(item.createdAt, now),
});

/**
 * `wait_on_user`, `resolve_wait` and `list_waits`: the agent's own list
 * of what the user must do outside the conversation, shown in the thread's tray and counted on its
 * sidebar row. *Self* tools for every thread, with no card, and a read. An item anchors to the reply
 * it was added in, as a `data-wait` chip there, which is where Jump to goes.
 */
export const waitAppTools = (
  waits: ThreadWaitsShape,
  runtimes: Pick<ThreadRuntimesShape, "audienceOf">,
) => [
  defineAppTool({
    descriptor: {
      name: "wait_on_user",
      class: "self",
      description:
        "Use `content` for the body (`body`, `text` and `message` are aliases). Add to the user's Waiting on you list what they must act on outside this conversation: " +
        "a `draft` to send elsewhere (Teams, mail, a PR), a `review` of a link, a `decision` you " +
        "can't make, an `action` only they can take. Not for status. Write a draft in your reply " +
        "as well; `copy` is what the Copy button copies, the exact text to paste, and without it " +
        "Copy takes the reply's quoted or fenced block. `link` is an http(s) URL to open. Pass the " +
        "`id` of an open item to update it, a revised draft say, rather than add another. Call " +
        "`resolve_wait` once it is done or no longer needed. At most " +
        `${MAX_OPEN_WAITS} open at once.`,
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
  defineAppTool({
    descriptor: {
      name: "resolve_wait",
      class: "self",
      description:
        "Take an item off the user's Waiting on you list once it is done or no longer needed, " +
        "with an optional `note` on why. An item the user already marked done answers " +
        '`resolvedBy: "user"`.',
    },
    input: Schema.Struct({
      id: WaitId,
      note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WAIT_BODY_MAX))),
    }),
    handle: (threadId, { id, note }) =>
      Effect.gen(function* () {
        const plainNote = note === undefined ? undefined : plainWaitText(note);
        const { item } = yield* waits.resolve(threadId, id, {
          by: "agent",
          at: Date.now(),
          ...(plainNote === undefined || plainNote === "" ? {} : { note: plainNote }),
        });
        return { id, resolvedBy: item.resolvedBy };
      }).pipe(
        Effect.mapError((e) =>
          e instanceof NotFound
            ? new AppToolError({ tool: "resolve_wait", message: `unknown item ${id}` })
            : failed("resolve_wait")(e),
        ),
      ),
  }),
  defineAppTool({
    descriptor: {
      name: "list_waits",
      class: "read",
      description:
        "List the user's Waiting on you items in this thread: the open ones, or with " +
        '`state: "all"` those resolved in the last 30 days too, each with its id, kind, title, ' +
        "who added and who resolved it, and its age. Items the user added themselves have " +
        '`source: "user"`. Read it after a compaction or a fresh session, rather than guess.',
    },
    input: Schema.Struct({ state: Schema.optionalKey(WaitListState) }),
    handle: (threadId, { state }) =>
      waits.listForAgent(threadId, state ?? "open").pipe(
        Effect.map((items) => {
          const now = Date.now();
          return { waits: items.map((item) => listedWait(item, now)) };
        }),
      ),
  }),
];
