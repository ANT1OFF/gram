import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { VIEW_INPUT_BATCH } from "../browser-view.ts";
import { InvalidState, ThreadNotFound } from "../errors.ts";
import { errors, threadRef } from "./shared.ts";

const Modifiers = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }));

/** One input a watcher sends the page (`ViewInput`); the browser host checks its bounds again. */
export const BrowserViewInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pointer"),
    action: Schema.Literals(["move", "down", "up"]),
    x: Schema.Finite,
    y: Schema.Finite,
    button: Schema.Literals(["none", "left", "middle", "right"]),
    buttons: Schema.Int,
    clickCount: Schema.Int,
    modifiers: Modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    x: Schema.Finite,
    y: Schema.Finite,
    deltaX: Schema.Finite,
    deltaY: Schema.Finite,
    modifiers: Modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up"]),
    key: Schema.String,
    code: Schema.String,
    keyCode: Schema.Int,
    text: Schema.optionalKey(Schema.String),
    modifiers: Modifiers,
    repeat: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type BrowserViewInput = typeof BrowserViewInput.Type;

/** The agent's page on the server (`ViewPage`). */
export const BrowserViewPage = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  driver: Schema.optionalKey(Schema.Literals(["agent", "user"])),
  action: Schema.optionalKey(Schema.Struct({ summary: Schema.String, at: Schema.Number })),
  recording: Schema.optionalKey(Schema.Boolean),
});
export type BrowserViewPage = typeof BrowserViewPage.Type;

export const BrowserViewEvent = Schema.Union([
  /** The thread's page now, first and on each change; `null` while it has none, and then why. */
  Schema.Struct({
    type: Schema.Literal("page"),
    page: Schema.NullOr(BrowserViewPage),
    status: Schema.optionalKey(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("starting") }),
        Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
      ]),
    ),
  }),
  /** One frame: a base64 JPEG, and the page's size in its own CSS pixels. */
  Schema.Struct({
    type: Schema.Literal("frame"),
    jpeg: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  }),
]);
export type BrowserViewEvent = typeof BrowserViewEvent.Type;

/**
 * The page a thread's agent drives in the server's own browser, for a client with no Preview pane
 * of its own: its frames, and a person's input to it. `InvalidState` where the server runs no such
 * browser.
 */
export const BrowserViewRpcs = RpcGroup.make(
  Rpc.make("browserView.subscribe", {
    payload: threadRef,
    success: BrowserViewEvent,
    error: errors(ThreadNotFound, InvalidState),
    stream: true,
  }),
  /** Pointer and key input. A click, a key or a scroll takes the page over from its agent. */
  Rpc.make("browserView.input", {
    payload: {
      ...threadRef,
      inputs: Schema.Array(BrowserViewInput).check(Schema.isMaxLength(VIEW_INPUT_BATCH)),
    },
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("browserView.control", {
    payload: { ...threadRef, op: Schema.Literals(["back", "forward", "reload", "handBack"]) },
    error: errors(ThreadNotFound, InvalidState),
  }),
);
