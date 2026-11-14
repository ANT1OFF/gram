// The server's door to the native shell's Preview pane over Electron's utilityProcess
// parentPort, or, with no desktop app, to a headless browser host the server forks
// (`GRAM_HEADLESS_BROWSER`). The shell owns every browsing rule; this module carries requests and
// stops waiting when a request times out or its caller is interrupted.

import { fork as nodeFork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  PANE_COMMAND_TIMEOUT_MS,
  type PaneCancelMessage,
  type PaneRequest,
  type PaneRequestMessage,
  type PaneResponseMessage,
  type PaneResult,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface PanePortShape {
  /** Sends one request to the shell; a missing shell or one that doesn't answer is a failed result. */
  send(request: PaneRequest): Effect.Effect<PaneResult>;
  /**
   * The door for watching a thread's page from a client (`views.ts`): only the headless browser
   * host has one, since the desktop app draws its pages itself.
   */
  readonly view?: PaneViewPort | undefined;
}

/** Messages about watching pages, to and from the browser host. */
export interface PaneViewPort {
  /** Sends the host a message if it is running; watching never starts it. */
  post(message: object): void;
  /** Hears every message the host sends. */
  on(listener: (message: unknown) => void): void;
  /** Hears each time the host stops, and its pages with it. */
  onStopped(listener: () => void): void;
}

export class PanePort extends Context.Service<PanePort, PanePortShape>()("@gram/server/PanePort") {
  /**
   * Native bridge when Electron supplied a parent port; else the headless browser host that
   * `GRAM_HEADLESS_BROWSER` names, when it does; otherwise there is no pane.
   */
  static readonly layer: Layer.Layer<PanePort> = Layer.sync(PanePort, () => {
    const port = (process as { parentPort?: PaneMessagePort }).parentPort;
    if (port !== undefined) return bridgePane(port);
    const hostModule = process.env["GRAM_HEADLESS_BROWSER"];
    if (hostModule === undefined || hostModule === "") return NO_PANE;
    const host = forkedPanePort(hostModule);
    return {
      ...bridgePane(host),
      view: {
        post: host.postIfRunning,
        on: (listener) => void host.on("message", ({ data }) => listener(data)),
        onStopped: host.onStopped,
      },
    };
  });
}

const NO_PANE: PanePortShape = {
  send: () =>
    Effect.succeed({
      ok: false,
      code: "noPane",
      message:
        "There is no Preview pane here: agents browse only in the Gram app, not in a browser tab.",
    }),
};

const timedOut: PaneResult = {
  ok: false,
  code: "failed",
  message: "The Preview pane didn't answer in time.",
};

// ---------------------------------------------------------------------------------------------
// Desktop: Electron main, over the utilityProcess port.

/** Electron's `process.parentPort` as the server sees it. */
export interface PaneMessagePort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
}

const isPaneResponse = (message: unknown): message is PaneResponseMessage =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "pane.response" &&
  typeof (message as { id?: unknown }).id === "string" &&
  typeof (message as { result?: unknown }).result === "object";

/** Pane commands over `port`, each answered by id or failed after `timeoutMs`. */
export const bridgePane = (
  port: PaneMessagePort,
  timeoutMs: number = PANE_COMMAND_TIMEOUT_MS,
): PanePortShape => {
  const pending = new Map<string, (result: PaneResult) => void>();
  port.on("message", ({ data }) => {
    if (!isPaneResponse(data)) return;
    pending.get(data.id)?.(data.result);
  });
  return {
    send: (request) =>
      Effect.callback<PaneResult>((resume) => {
        const id = randomUUID();
        const cancel = () => {
          if (!pending.delete(id)) return;
          const message: PaneCancelMessage = { type: "pane.cancel", id };
          port.postMessage(message);
        };
        const timer = setTimeout(() => {
          cancel();
          settle(timedOut);
        }, timeoutMs);
        function settle(result: PaneResult) {
          clearTimeout(timer);
          pending.delete(id);
          resume(Effect.succeed(result));
        }
        pending.set(id, settle);
        const message: PaneRequestMessage = { type: "pane.request", id, request };
        port.postMessage(message);
        return Effect.sync(() => {
          clearTimeout(timer);
          cancel();
        });
      }),
  };
};

// ---------------------------------------------------------------------------------------------
// No desktop app: a headless browser host, forked.

type Fork = (modulePath: string, args: ReadonlyArray<string>, options: ForkOptions) => ChildProcess;

/** What the browser host is started with: where things are, and which browser to run. */
const HOST_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "FONTCONFIG_PATH",
  "FONTCONFIG_FILE",
  "GRAM_BROWSER_EXECUTABLE",
  "GRAM_BROWSER_SANDBOX",
] as const;

/**
 * The host's environment out of the server's: none of its tokens, proxies or debug switches
 * (`NODE_OPTIONS` among them) reach a process that renders pages an agent wrote.
 */
export const browserHostEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    HOST_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  );

const hostGone = (id: string): PaneResponseMessage => ({
  type: "pane.response",
  id,
  result: { ok: false, code: "failed", message: "The browser on the server stopped." },
});

/**
 * A port to the browser host at `modulePath`, forked on the first message and again on the first
 * one after it stops. A request it was still running when it stopped fails at once.
 */
export const forkedPanePort = (
  modulePath: string,
  fork: Fork = nodeFork,
): PaneMessagePort & {
  /** Sends `message` to the host if one is running, and starts none. */
  postIfRunning(message: object): void;
  onStopped(listener: () => void): void;
} => {
  const listeners = new Set<(event: { readonly data: unknown }) => void>();
  const deliver = (data: unknown) => {
    for (const listener of Array.from(listeners)) listener({ data });
  };
  const stops = new Set<() => void>();
  /** The requests the current host hasn't answered. */
  const open = new Set<string>();
  let child: ChildProcess | undefined;
  const live = (): ChildProcess => {
    if (child !== undefined) return child;
    const started = fork(modulePath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      // Not the server's own flags, such as `--watch` in development.
      execArgv: [],
      env: browserHostEnv(process.env),
    });
    child = started;
    started.on("message", (message) => {
      if (isPaneResponse(message)) open.delete(message.id);
      deliver(message);
    });
    const stopped = () => {
      if (child !== started) return;
      child = undefined;
      const unanswered = Array.from(open);
      open.clear();
      for (const id of unanswered) deliver(hostGone(id));
      for (const listener of Array.from(stops)) listener();
    };
    started.once("exit", stopped);
    started.on("error", stopped);
    return started;
  };
  return {
    postMessage: (message) => {
      const { type, id } = message as { type?: unknown; id?: unknown };
      if (typeof id === "string") {
        if (type === "pane.request") open.add(id);
        else if (type === "pane.cancel") open.delete(id);
      }
      const host = live();
      host.send(message as object, (error) => {
        if (error !== null && typeof id === "string" && type === "pane.request" && open.delete(id))
          deliver(hostGone(id));
      });
    },
    on: (_event, listener) => {
      listeners.add(listener);
      return undefined;
    },
    postIfRunning: (message) => {
      child?.send(message, () => {});
    },
    onStopped: (listener) => {
      stops.add(listener);
    },
  };
};
