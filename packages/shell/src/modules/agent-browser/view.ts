import {
  VIEW_IDLE_MS,
  VIEW_LEASE_MS,
  viewInputTakes,
  viewServerMessage,
  type ViewHostMessage,
  type ViewInput,
  type ViewPage,
  type ViewStatus,
} from "@gram/contracts/link-trust";

import type { HeadlessPage } from "./headless.ts";
import type { AgentPanes, PaneContents } from "./pane.ts";
import { fieldsOf } from "@gram/contracts";

const QUEUE_MAX = 64;

export interface ViewsOptions {
  readonly panes: Pick<
    AgentPanes,
    "driverOf" | "actionOf" | "recordingOf" | "takeOver" | "handBack"
  >;
  /** The thread's page if it has one; never makes one. */
  readonly pageOf: (threadId: string) => Promise<PaneContents | undefined>;
  /** What watching `contents` needs (`headlessPage`). */
  readonly watch: (contents: PaneContents) => HeadlessPage | undefined;
  /** Why the thread has no page, when the host knows. */
  readonly statusOf: (threadId: string) => ViewStatus | undefined;
  readonly send: (message: ViewHostMessage) => void;
  /** How long a person keeps the page after their last input; `VIEW_IDLE_MS` unless a test says. */
  readonly idleMs?: number;
  readonly leaseMs?: number;
  /** How often a watched thread is looked at again for a page that came, went or changed. */
  readonly pollMs?: number;
}

export interface Views {
  /** Takes one message from the server; false when it wasn't about a view. */
  message(raw: unknown): boolean;
  /** Something about the thread's page may have changed: its watchers hear if it did. */
  changed(threadId: string): void;
  /** Stops every watch and timer. */
  close(): void;
}

interface Watch {
  expires: number;
  contents: PaneContents | undefined;
  stop: (() => void) | undefined;
  sent: string | undefined;
}

export const createViews = (options: ViewsOptions): Views => {
  const { panes, send } = options;
  const idleMs = options.idleMs ?? VIEW_IDLE_MS;
  const leaseMs = options.leaseMs ?? VIEW_LEASE_MS;
  const watches = new Map<string, Watch>();
  const idle = new Map<string, ReturnType<typeof setTimeout>>();
  const typing = new Map<string, Promise<void>>();
  const queued = new Map<string, number>();
  let poll: ReturnType<typeof setInterval> | undefined;

  const pageOf = (threadId: string, contents: PaneContents, page: HeadlessPage): ViewPage => {
    const driver = panes.driverOf(threadId);
    const action = panes.actionOf(threadId);
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: page.canGoBack(),
      canGoForward: page.canGoForward(),
      ...(driver === undefined ? {} : { driver }),
      ...(action === undefined ? {} : { action }),
      ...(panes.recordingOf(threadId) ? { recording: true } : {}),
    };
  };

  const giveBack = (threadId: string) => {
    const contents = watches.get(threadId)?.contents;
    if (contents !== undefined && !contents.isDestroyed()) options.watch(contents)?.letGo();
    panes.handBack(threadId);
  };

  const release = (threadId: string) => {
    clearTimeout(idle.get(threadId));
    idle.delete(threadId);
    giveBack(threadId);
  };

  const detach = (watch: Watch) => {
    watch.stop?.();
    watch.stop = undefined;
    watch.contents = undefined;
  };

  const refresh = async (threadId: string) => {
    const watch = watches.get(threadId);
    if (watch === undefined) return;
    const contents = await options.pageOf(threadId).catch(() => undefined);
    if (watches.get(threadId) !== watch) return;
    const page = contents === undefined ? undefined : options.watch(contents);
    if (contents !== watch.contents) {
      detach(watch);
      if (contents !== undefined && page !== undefined) {
        watch.contents = contents;
        watch.stop = page.screencast((frame) => {
          if (watches.get(threadId) === watch && watch.contents === contents)
            send({ type: "pane.view.frame", threadId, ...frame });
        });
      }
    }
    const shown =
      contents === undefined || page === undefined || contents.getURL() === ""
        ? null
        : pageOf(threadId, contents, page);
    const status = shown === null ? options.statusOf(threadId) : undefined;
    const message: ViewHostMessage = {
      type: "pane.view.page",
      threadId,
      page: shown,
      ...(status === undefined ? {} : { status }),
    };
    const text = JSON.stringify(message);
    if (text === watch.sent) return;
    watch.sent = text;
    send(message);
  };

  const tick = () => {
    const now = Date.now();
    for (const [threadId, watch] of Array.from(watches)) {
      if (watch.expires > now) {
        void refresh(threadId);
        continue;
      }
      if (idle.has(threadId)) release(threadId);
      detach(watch);
      watches.delete(threadId);
    }
    if (watches.size === 0) {
      clearInterval(poll);
      poll = undefined;
    }
  };

  const watchThread = (threadId: string, fresh: boolean) => {
    const known = watches.get(threadId);
    if (known !== undefined) {
      known.expires = Date.now() + leaseMs;
      if (fresh) {
        detach(known);
        known.sent = undefined;
        void refresh(threadId);
      }
      return;
    }
    watches.set(threadId, {
      expires: Date.now() + leaseMs,
      contents: undefined,
      stop: undefined,
      sent: undefined,
    });
    poll ??= setInterval(tick, options.pollMs ?? 500);
    void refresh(threadId);
  };

  const acted = (threadId: string) => {
    if (panes.driverOf(threadId) === "agent") panes.takeOver(threadId);
    clearTimeout(idle.get(threadId));
    idle.set(
      threadId,
      setTimeout(() => {
        idle.delete(threadId);
        giveBack(threadId);
        void refresh(threadId);
      }, idleMs),
    );
  };

  const input = async (threadId: string, inputs: ReadonlyArray<ViewInput>) => {
    const watch = watches.get(threadId);
    const contents = watch?.contents;
    const page = contents === undefined ? undefined : options.watch(contents);
    if (contents === undefined || page === undefined) return;
    for (const each of inputs) {
      if (watches.get(threadId)?.contents !== contents || contents.isDestroyed()) return;
      if (viewInputTakes(each)) acted(threadId);
      if (panes.driverOf(threadId) !== "user") continue;
      if (idle.has(threadId)) acted(threadId);
      await page.input(each);
    }
    void refresh(threadId);
  };

  return {
    message: (raw) => {
      const message = viewServerMessage(raw);
      if (message === undefined) return String(fieldsOf(raw).get("type")).startsWith("pane.view.");
      const { threadId } = message;
      if (message.type === "pane.view.watch") watchThread(threadId, message.fresh === true);
      else if (message.type === "pane.view.input") {
        const waiting = queued.get(threadId) ?? 0;
        if (waiting >= QUEUE_MAX) return true;
        queued.set(threadId, waiting + 1);
        const after = (typing.get(threadId) ?? Promise.resolve())
          .then(() => input(threadId, message.inputs))
          .catch(() => {});
        typing.set(threadId, after);
        void after.then(() => {
          const left = (queued.get(threadId) ?? 1) - 1;
          if (left > 0) queued.set(threadId, left);
          else queued.delete(threadId);
          if (typing.get(threadId) === after) typing.delete(threadId);
        });
      } else {
        const watch = watches.get(threadId);
        const contents = watch?.contents;
        const page = contents === undefined ? undefined : options.watch(contents);
        if (contents === undefined || page === undefined || contents.isDestroyed()) return true;
        if (message.op === "handBack") release(threadId);
        else {
          acted(threadId);
          if (panes.driverOf(threadId) === "user") {
            if (message.op === "back") {
              contents.navigationHistory.goBack();
            } else if (message.op === "forward") page.goForward();
            else page.reload();
          }
        }
        void refresh(threadId);
      }
      return true;
    },
    changed: (threadId) => {
      void refresh(threadId);
    },
    close: () => {
      clearInterval(poll);
      poll = undefined;
      for (const watch of watches.values()) detach(watch);
      watches.clear();
      for (const timer of idle.values()) clearTimeout(timer);
      idle.clear();
    },
  };
};
