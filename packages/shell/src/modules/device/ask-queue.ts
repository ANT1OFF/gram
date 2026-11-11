import { randomBytes } from "node:crypto";
import { ASK_ARM_MS, type AskPageAnswer } from "./ask-page.ts";
import type { AskView } from "./ask-view.ts";
import type { AskAnswer, AskRequest } from "./gate.ts";

/**
 * The asks, one on screen at a time. Others wait behind it in the order they came. An ask taken
 * back while on screen stays there as withdrawn until the person dismisses it, so the next ask
 * never slides into its place. An allow counts only for the ask on screen, and only once its
 * content has been there a full second, whatever the page says.
 */

/** Where an ask is drawn: the window the main process owns. */
export interface AskSurface {
  /** Draws an ask and settles once it is on screen. */
  readonly show: (show: string, view: AskView) => Promise<void>;
  readonly withdraw: (show: string, why: string) => void;
  /** Nothing left to ask: the window goes. */
  readonly hide: () => void;
}

export interface AskQueueOptions {
  readonly surface: AskSurface;
  readonly view: (request: AskRequest) => AskView;
  /** Tells the person an ask is waiting, without taking their focus. */
  readonly notify: (view: AskView) => void;
  /** A clock that only goes forward. */
  readonly elapsed: () => number;
}

export interface AskQueue {
  /** The gate's `ask`. */
  readonly ask: (request: AskRequest, withdrawn: AbortSignal) => Promise<AskAnswer>;
  /** What the window answered, for the ask it showed. */
  readonly answered: (show: string, answer: AskPageAnswer) => void;
  /** Ends everything waiting and on screen, as a quit does. */
  readonly close: () => void;
  readonly waiting: () => number;
}

interface Waiting {
  readonly request: AskRequest;
  readonly done: (answer: AskAnswer) => void;
  readonly withdrawn: AbortSignal;
}

type OnScreen =
  | { readonly state: "asking"; readonly show: string; readonly item: Waiting; shownAt?: number }
  | { readonly state: "withdrawn"; readonly show: string };

const NO: AskAnswer = { allowed: false };

export const makeAskQueue = (options: AskQueueOptions): AskQueue => {
  const waiting: Array<Waiting> = [];
  let onScreen: OnScreen | undefined;
  let closed = false;

  const next = () => {
    if (onScreen !== undefined || closed) return;
    const item = waiting.shift();
    if (item === undefined) {
      options.surface.hide();
      return;
    }
    if (item.withdrawn.aborted) {
      item.done(NO);
      next();
      return;
    }
    const show = randomBytes(12).toString("base64url");
    const current: OnScreen = { state: "asking", show, item };
    onScreen = current;
    const view = options.view(item.request);
    options.notify(view);
    options.surface
      .show(show, view)
      .then(() => {
        if (onScreen === current) current.shownAt = options.elapsed();
      })
      .catch(() => {
        // A window that can't draw the ask can't be answered: it is refused.
        if (onScreen !== current) return;
        onScreen = undefined;
        item.done(NO);
        next();
      });
  };

  return {
    ask: (request, withdrawn) =>
      new Promise<AskAnswer>((done) => {
        if (closed || withdrawn.aborted) {
          done(NO);
          return;
        }
        const item: Waiting = { request, done, withdrawn };
        withdrawn.addEventListener(
          "abort",
          () => {
            const at = waiting.indexOf(item);
            if (at >= 0) {
              waiting.splice(at, 1);
              done(NO);
              return;
            }
            if (onScreen?.state === "asking" && onScreen.item === item) {
              const { show } = onScreen;
              onScreen = { state: "withdrawn", show };
              options.surface.withdraw(show, "Withdrawn");
              done(NO);
            }
          },
          { once: true },
        );
        waiting.push(item);
        next();
      }),
    answered: (show, answer) => {
      const current = onScreen;
      if (current === undefined || current.show !== show) return;
      if (current.state === "withdrawn") {
        if (answer !== "dismiss") return;
        onScreen = undefined;
        next();
        return;
      }
      if (answer === "dismiss") return;
      if (answer === "allow") {
        // On screen a full second by this clock too, or the click doesn't count.
        if (current.shownAt === undefined || options.elapsed() - current.shownAt < ASK_ARM_MS)
          return;
        onScreen = undefined;
        current.item.done({ allowed: true, hash: current.item.request.hash });
        next();
        return;
      }
      onScreen = undefined;
      current.item.done(NO);
      next();
    },
    close: () => {
      closed = true;
      for (const item of waiting.splice(0)) item.done(NO);
      if (onScreen?.state === "asking") onScreen.item.done(NO);
      onScreen = undefined;
      options.surface.hide();
    },
    waiting: () => waiting.length + (onScreen?.state === "asking" ? 1 : 0),
  };
};
