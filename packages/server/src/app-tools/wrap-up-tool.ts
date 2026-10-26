import {
  AppToolError,
  WRAP_UP_ASK_MAX_CHARS,
  WRAP_UP_LABEL_MAX_CHARS,
  WRAP_UP_MAX_ACTIONS,
  WRAP_UP_MESSAGE_MAX_CHARS,
  WRAP_UP_RECAP_MAX_CHARS,
  WrapUpAppAction,
  effectiveCheckout,
  wrapUpActionsFor,
  type GitState,
  type WrapUpButton,
  type WrapUpData,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GitStatePublisher, type GitStatePublisherShape } from "../git/publisher.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { ThreadRuntimes, type ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { defineAppTool, failed } from "./definition.ts";
import { AppToolRegistry } from "./registry.ts";

const TOOL = "wrap_up";

/**
 * What the tool's result tells the agent to do next, by whether the box shows a question. Either
 * way a closing message follows: the box is a summary, not the answer, and a question needs its
 * reasons and options said where the user reads them. An agent that already wrote that text in the
 * same reply as the call is told not to say it again.
 */
export const WRAP_UP_CLOSE =
  "The box shows your recap. Now write your closing message, your answer to the user in full, " +
  "as the last thing you say this turn; if you already wrote it, end the turn.";
export const WRAP_UP_ASKED =
  "The box shows your recap and your question with its buttons. Now write your closing message: " +
  "what the user needs in order to decide (the reasons, the options and your pick), without " +
  "asking the question again; if you already wrote that, end the turn. Do no more work this turn.";

const ActionInput = Schema.Struct({
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WRAP_UP_LABEL_MAX_CHARS))),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WRAP_UP_MESSAGE_MAX_CHARS))),
  action: Schema.optionalKey(WrapUpAppAction),
});

export const WrapUpInput = Schema.Struct({
  recap: Schema.String.check(Schema.isMaxLength(WRAP_UP_RECAP_MAX_CHARS)),
  ask: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WRAP_UP_ASK_MAX_CHARS))),
  actions: Schema.optionalKey(
    Schema.Array(ActionInput).check(Schema.isMaxLength(WRAP_UP_MAX_ACTIONS)),
  ),
});
export type WrapUpInput = typeof WrapUpInput.Type;

const refuse = (message: string) => Effect.fail(new AppToolError({ tool: TOOL, message }));

/** One line of plain prose of at most `max` characters, or why not. */
const proseProblem = (name: string, text: string, max: number): string | undefined => {
  if (text === "") return `${name} is empty.`;
  if (text.length > max) return `${name} is ${text.length} characters; keep it to ${max}.`;
  if (/\n/.test(text)) return `${name} must be one line.`;
  return undefined;
};

/**
 * The box as the user will see it, or why the call is refused. An app action is checked against
 * what the thread's git state offers now, so a button never stands for a control with nothing to do.
 */
const wrapUpButtons = (
  input: WrapUpInput,
  git: GitState | undefined,
): { readonly recap: string; readonly ask?: string; readonly actions: WrapUpButton[] } | string => {
  const recap = input.recap.trim();
  const recapProblem = proseProblem("recap", recap, WRAP_UP_RECAP_MAX_CHARS);
  if (recapProblem !== undefined) return recapProblem;
  const ask = input.ask?.trim();
  if (ask !== undefined) {
    const askProblem = proseProblem("ask", ask, WRAP_UP_ASK_MAX_CHARS);
    if (askProblem !== undefined) return askProblem;
    if ((ask.match(/\?/g) ?? []).length > 1) return "ask is one question, not several.";
  }
  const raw = input.actions ?? [];
  if (raw.length === 0) return { recap, ...(ask === undefined ? {} : { ask }), actions: [] };
  if (ask === undefined) return "actions are answers to ask: pass ask too, or leave actions out.";
  if (raw.length > WRAP_UP_MAX_ACTIONS) {
    return `at most ${WRAP_UP_MAX_ACTIONS} actions, your pick first.`;
  }
  const available = wrapUpActionsFor(git);
  const actions: WrapUpButton[] = [];
  for (const item of raw) {
    if (item.action !== undefined) {
      if (item.label !== undefined || item.message !== undefined) {
        return "an action is either a reply (label and message) or an app action, not both.";
      }
      if (!available.includes(item.action)) {
        return available.length === 0
          ? `${item.action} isn't available for this thread now, nor is any app action; use a reply.`
          : `${item.action} isn't available for this thread now; available: ${available.join(", ")}.`;
      }
      actions.push({ kind: "app", action: item.action });
      continue;
    }
    const label = item.label?.trim() ?? "";
    const labelProblem = proseProblem("label", label, WRAP_UP_LABEL_MAX_CHARS);
    if (labelProblem !== undefined) return labelProblem;
    const message = item.message?.trim() || label;
    if (message.length > WRAP_UP_MESSAGE_MAX_CHARS) {
      return `message is ${message.length} characters; keep it to ${WRAP_UP_MESSAGE_MAX_CHARS}.`;
    }
    actions.push({ kind: "reply", label, message });
  }
  const keys = actions.map((a) => (a.kind === "app" ? `app:${a.action}` : `reply:${a.label}`));
  if (new Set(keys).size !== keys.length) return "the actions must differ.";
  return { recap, ask, actions };
};

/**
 * How the agent is told when to call `wrap_up`, and how. The cases it names are the ones an agent
 * gets wrong without them: a box from a subagent, a recap written before the work is over, a turn
 * that ends blocked with no box, a question box with nothing above it to decide by, and a box on a
 * turn that only answered a question.
 */
export const WRAP_UP_DESCRIPTION =
  "Fill the box Gram shows under the transcript when your turn ends. Call it as the last tool " +
  "call of a turn that changed something (files, commits, a branch, a pull request) or did " +
  "multi-step work, once that work is done and checked, and before your closing message. Call " +
  "it too when such a turn stops early because you are blocked or something failed. Skip it " +
  "when the turn only answered a question or talked, even if you read files or ran commands to " +
  "answer. If you do more work after calling it, call it again: the newer box replaces the " +
  "older. Only the main agent calls it; a subagent never does. " +
  `recap: two or three short sentences (at most ${WRAP_UP_RECAP_MAX_CHARS} characters) on ` +
  "what is now true, then what is not done or not verified. Only when the next move is the " +
  "user's decision (a choice, a go-ahead, an approval), add ask: that one question, at most " +
  `${WRAP_UP_ASK_MAX_CHARS} characters, without the reasons or the options, which go in your ` +
  "closing message; never for something another prompt already asks, such as a plan approval or " +
  "a permission. With ask, add actions: 1–2 buttons that answer it, your pick first, each " +
  `either a reply ({label, message}: label at most ${WRAP_UP_LABEL_MAX_CHARS} characters, ` +
  "message what the click sends) or one of " +
  'Gram\'s own controls ({action: "push" | "create_pr" | "merge"}) while the thread has ' +
  "something for it to do. The user still confirms a control where Gram asks. The result says " +
  "what your closing message should hold.";

/**
 * `wrap_up`: the agent's own recap at the end of a turn, and, when the next move is the user's, one
 * question with up to two buttons that answer it. It is a data part on the turn's reply, which the
 * card under the transcript shows once the turn ends, and which `thread.recap` serves for that turn
 * in place of asking the helper. A self tool: it writes only to the calling thread's transcript.
 */
export const wrapUpTool = (
  runtimes: Pick<ThreadRuntimesShape, "emitChunk">,
  store: Pick<ThreadStoreShape, "getThread" | "lastTurn">,
  git: Pick<GitStatePublisherShape, "stateForThread" | "refresh">,
) =>
  defineAppTool({
    descriptor: {
      name: TOOL,
      class: "self",
      description: WRAP_UP_DESCRIPTION,
    },
    audience: ["plain", "worker"],
    input: WrapUpInput,
    rejectExcessProperties: true,
    handle: (threadId, input) =>
      Effect.gen(function* () {
        const turn = yield* store.lastTurn(threadId);
        if (turn === undefined || turn.endedAt !== undefined) {
          return yield* refuse("wrap_up closes a turn; call it before the turn ends.");
        }
        const thread = yield* store.getThread(threadId).pipe(Effect.mapError(failed(TOOL)));
        // The agent has often just committed: an app action is checked against the checkout as it
        // is now, not the last state the publisher happened to read.
        if (input.actions?.some((item) => item.action !== undefined) === true) {
          yield* git.refresh(effectiveCheckout(thread).path, { remote: false, rebase: false });
        }
        const box = wrapUpButtons(input, yield* git.stateForThread(thread));
        if (typeof box === "string") return yield* refuse(box);
        // One box per turn: a second call replaces the first.
        const id = `wrap-up:${turn.id}`;
        const data: WrapUpData = {
          id,
          turnId: turn.id,
          recap: box.recap,
          ...(box.ask === undefined ? {} : { ask: box.ask }),
          actions: box.actions,
          at: yield* Clock.currentTimeMillis,
        };
        yield* runtimes
          .emitChunk(threadId, { type: "data-wrap-up", id, data })
          .pipe(Effect.mapError(failed(TOOL)));
        return {
          shown: box.ask === undefined ? "recap" : "recap and question",
          ...(box.actions.length === 0
            ? {}
            : {
                buttons: box.actions.map((a) => (a.kind === "app" ? a.action : a.label)),
              }),
          next: box.ask === undefined ? WRAP_UP_CLOSE : WRAP_UP_ASKED,
        };
      }),
  });

/** Registers `wrap_up`, which reads the thread's git state to check its app actions. */
export const WrapUpAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const publisher = yield* GitStatePublisher;
    yield* registry.register([wrapUpTool(runtimes, store, publisher)]);
  }),
);
