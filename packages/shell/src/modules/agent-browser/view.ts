// Watching an agent's page in the headless browser from somewhere else: the server asks for a
// thread's page (`pane.view.watch`), and while it keeps asking the host sends what the page is
// and its frames, and puts a person's input into it. A click, a key or a scroll takes the page
// over from its agent, as input in the desktop app's pane does; it goes back to the agent when
// the person hands it back, or has sent nothing for a while.

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
  /** What was last sent of the page, so only a change is sent. */
  sent: string | undefined;
}

export const createViews = (options: ViewsOptions): Views => {
  const { panes, send } = options;
  const idleMs = options.idleMs ?? VIEW_IDLE_MS;
  const leaseMs = options.leaseMs ?? VIEW_LEASE_MS;
  const watches = new Map<string, Watch>();
  /** When each thread's person is taken to have left, by their last input. */
  const idle = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each thread's inputs so far are in its page, so the next batch follows them. */
  const typing = new Map<string, Promise<void>>();
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

  const release = (threadId: string) => {
    clearTimeout(idle.get(threadId));
    idle.delete(threadId);
    panes.handBack(threadId);
  };

  const detach = (watch: Watch) => {
    watch.stop?.();
    watch.stop = undefined;
    watch.contents = undefined;
  };

  /** Brings what a thread's watchers have in line with its page now. */
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
    // A page that hasn't been anywhere yet is no page to show.
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
      // Nobody is watching any more: the frames stop, and a page a person held is the agent's.
      detach(watch);
      watches.delete(threadId);
      if (idle.has(threadId)) release(threadId);
    }
    if (watches.size === 0) {
      clearInterval(poll);
      poll = undefined;
    }
  };

  const watchThread = (threadId: string) => {
    const known = watches.get(threadId);
    if (known !== undefined) {
      known.expires = Date.now() + leaseMs;
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

  /** The person acted: the page is theirs, until `idleMs` passes with nothing more from them. */
  const acted = (threadId: string) => {
    if (panes.driverOf(threadId) === "agent") panes.takeOver(threadId);
    clearTimeout(idle.get(threadId));
    idle.set(
      threadId,
      setTimeout(() => {
        idle.delete(threadId);
        panes.handBack(threadId);
        void refresh(threadId);
      }, idleMs),
    );
  };

  const input = async (threadId: string, inputs: ReadonlyArray<ViewInput>) => {
    // Only a watched page takes input: what a person can't see, they don't drive.
    const watch = watches.get(threadId);
    const contents = watch?.contents;
    const page = contents === undefined ? undefined : options.watch(contents);
    if (contents === undefined || page === undefined || contents.isDestroyed()) return;
    for (const each of inputs) {
      if (viewInputTakes(each)) acted(threadId);
      // A pointer passing over the agent's page, or a release with no press, isn't the person's
      // to send: nothing reaches the page until they have it.
      if (panes.driverOf(threadId) !== "user") continue;
      if (idle.has(threadId)) acted(threadId);
      await page.input(each);
    }
    void refresh(threadId);
  };

  return {
    message: (raw) => {
      const message = viewServerMessage(raw);
      if (message === undefined)
        return (
          typeof (raw as { type?: unknown } | null)?.type === "string" &&
          (raw as { type: string }).type.startsWith("pane.view.")
        );
      const { threadId } = message;
      if (message.type === "pane.view.watch") watchThread(threadId);
      else if (message.type === "pane.view.input") {
        // One batch after another: a release never overtakes its press.
        const after = (typing.get(threadId) ?? Promise.resolve())
          .then(() => input(threadId, message.inputs))
          .catch(() => {});
        typing.set(threadId, after);
        void after.then(() => {
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
              if (page.canGoBack()) contents.navigationHistory.goBack();
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
