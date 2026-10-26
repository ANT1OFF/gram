import * as Schema from "effect/Schema";
import type { GitState } from "./git.ts";
import { TurnId } from "./ids.ts";
import type { GramUIMessage } from "./ui-message.ts";

// The agent's own end-of-turn box: the `wrap_up` app tool's recap, and the one question and the
// buttons it may leave the user. It costs no helper call and needs no helper consent, and for the
// turn it covers it stands in place of the helper's recap.

/** A recap longer than this is refused, not cut: two or three short sentences. */
export const WRAP_UP_RECAP_MAX_CHARS = 300;

/** The one question, when the next move is the user's. */
export const WRAP_UP_ASK_MAX_CHARS = 100;

/** A reply button's words. */
export const WRAP_UP_LABEL_MAX_CHARS = 24;

/** What a reply button sends. */
export const WRAP_UP_MESSAGE_MAX_CHARS = 300;

/** At most this many buttons, the agent's pick first. */
export const WRAP_UP_MAX_ACTIONS = 2;

/**
 * Gram's own controls a button may stand for. Each opens or runs the control the thread's header
 * already has, so the user still confirms where that control does: Create PR opens its dialog, and
 * merging opens the PR panel, whose Merge asks first.
 */
export const WrapUpAppAction = Schema.Literals(["push", "create_pr", "merge"]);
export type WrapUpAppAction = typeof WrapUpAppAction.Type;

export const WrapUpButton = Schema.Union([
  /** Sends `message` as the user's next message. */
  Schema.Struct({ kind: Schema.Literal("reply"), label: Schema.String, message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("app"), action: WrapUpAppAction }),
]);
export type WrapUpButton = typeof WrapUpButton.Type;

/** The `wrap-up` data part: the box at the end of the turn that called `wrap_up`. */
export const WrapUpDataSchema = Schema.Struct({
  id: Schema.String,
  /** The turn it covers; a newer turn makes it history. */
  turnId: TurnId,
  recap: Schema.String,
  /** Present when the next move is the user's decision. */
  ask: Schema.optionalKey(Schema.String),
  actions: Schema.Array(WrapUpButton),
  /** Epoch ms. */
  at: Schema.Number,
});
export type WrapUpData = typeof WrapUpDataSchema.Type;

/**
 * What a push would do: publish a branch that isn't on origin yet, push commits origin doesn't have,
 * or nothing (synced, behind, diverged, detached, or no GitHub origin).
 */
export const pushActionOf = (git: GitState | undefined): "publish" | "push" | undefined => {
  if (!git?.repo || git.missing === true || git.branch === undefined || git.origin === undefined)
    return undefined;
  if (git.upstream === undefined) return "publish";
  return git.upstream === "ahead" ? "push" : undefined;
};

/** Whether a PR can be opened for this branch: it has a GitHub origin and no PR yet. */
export const canCreatePr = (git: GitState | undefined): boolean =>
  git?.repo === true && git.branch !== undefined && git.origin !== undefined && !git.pr;

/** Whether `action` has something to do for a thread in `git`'s state, as its header would show. */
export const wrapUpActionAvailable = (
  action: WrapUpAppAction,
  git: GitState | undefined,
): boolean => {
  switch (action) {
    case "push":
      return pushActionOf(git) !== undefined;
    case "create_pr":
      return canCreatePr(git);
    case "merge":
      return git?.pr?.state === "OPEN" && !git.pr.isDraft;
  }
};

/** The app actions available for a thread in `git`'s state, in `WrapUpAppAction`'s order. */
export const wrapUpActionsFor = (git: GitState | undefined): ReadonlyArray<WrapUpAppAction> =>
  WrapUpAppAction.literals.filter((action) => wrapUpActionAvailable(action, git));

/** The buttons of `data` that still apply: an app action whose control has nothing to do goes. */
export const liveWrapUpButtons = (
  data: Pick<WrapUpData, "actions">,
  git: GitState | undefined,
): ReadonlyArray<WrapUpButton> =>
  data.actions.filter(
    (button) => button.kind === "reply" || wrapUpActionAvailable(button.action, git),
  );

/**
 * The last `wrap_up` the latest turn left in `messages`, after the last user message, since one
 * sent after the box is the user answering it. A turn the agent started on its own sends none, so
 * the latest reply's own turn is what counts: a box from the turn before it is history. With
 * `turnId`, only one for that turn.
 */
export const latestWrapUp = (
  messages: ReadonlyArray<GramUIMessage>,
  turnId?: TurnId,
): WrapUpData | undefined => {
  let latest = turnId;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return undefined;
    // A subagent's transcript is not the turn's own: its tools aren't the thread's.
    if (message.metadata?.parentToolUseId !== undefined) continue;
    latest ??= message.metadata?.turnId;
    const part = message.parts.findLast((p) => p.type === "data-wrap-up");
    if (part?.type === "data-wrap-up") {
      return latest === undefined || part.data.turnId === latest ? part.data : undefined;
    }
  }
  return undefined;
};
