import type { ChildProcess, ForkOptions } from "node:child_process";
import { EventEmitter } from "node:events";

import type { PaneRequest, PaneResult } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { bridgePane, browserHostEnv, forkedPanePort } from "./pane-port.ts";

const REQUEST: PaneRequest = {
  threadId: "thread-1",
  limits: { actOnLoopbackOnly: true },
  command: { op: "snapshot" },
};

const OK: PaneResult = { ok: true, page: null };

/** A forked host that records what it was sent and answers as each test says. */
const fakeHost = () => {
  const children: Array<EventEmitter & { sent: Array<unknown> }> = [];
  let answer: ((message: { type: string; id: string }) => unknown) | undefined;
  const fork = (modulePath: string, _args: ReadonlyArray<string>, options: ForkOptions) => {
    expect(modulePath).toBe("/opt/host.ts");
    expect(options.execArgv).toEqual([]);
    expect(options.env).toEqual(browserHostEnv(process.env));
    const child = Object.assign(new EventEmitter(), {
      sent: [] as Array<unknown>,
      send: (message: { type: string; id: string }, callback: (error: Error | null) => void) => {
        child.sent.push(message);
        callback(null);
        const reply = answer?.(message);
        if (reply !== undefined) queueMicrotask(() => child.emit("message", reply));
        return true;
      },
    });
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return {
    fork,
    children,
    answer: (run: (message: { type: string; id: string }) => unknown) => {
      answer = run;
    },
  };
};

describe("forkedPanePort", () => {
  it("forks the host on the first request and carries its answer back", async () => {
    const host = fakeHost();
    host.answer((message) =>
      message.type === "pane.request"
        ? { type: "pane.response", id: message.id, result: OK }
        : undefined,
    );
    const pane = bridgePane(forkedPanePort("/opt/host.ts", host.fork));
    expect(host.children).toHaveLength(0);
    expect(await Effect.runPromise(pane.send(REQUEST))).toEqual(OK);
    expect(await Effect.runPromise(pane.send(REQUEST))).toEqual(OK);
    expect(host.children).toHaveLength(1);
    expect(host.children[0]!.sent).toHaveLength(2);
  });

  it("fails what a stopped host was running at once, and forks a new one for the next", async () => {
    const host = fakeHost();
    const pane = bridgePane(forkedPanePort("/opt/host.ts", host.fork), 60_000);
    const running = Effect.runPromise(pane.send(REQUEST));
    await Promise.resolve();
    host.children[0]!.emit("exit", 1, null);
    expect(await running).toEqual({
      ok: false,
      code: "failed",
      message: "The browser on the server stopped.",
    });
    host.answer((message) =>
      message.type === "pane.request"
        ? { type: "pane.response", id: message.id, result: OK }
        : undefined,
    );
    expect(await Effect.runPromise(pane.send(REQUEST))).toEqual(OK);
    expect(host.children).toHaveLength(2);
  });

  it("doesn't fail a request the host already answered when it stops later", async () => {
    const host = fakeHost();
    const seen: Array<unknown> = [];
    const port = forkedPanePort("/opt/host.ts", host.fork);
    port.on("message", ({ data }) => seen.push(data));
    host.answer((message) => ({ type: "pane.response", id: message.id, result: OK }));
    port.postMessage({ type: "pane.request", id: "a", request: REQUEST });
    await Promise.resolve();
    host.children[0]!.emit("exit", 0, null);
    expect(seen).toEqual([{ type: "pane.response", id: "a", result: OK }]);
  });

  it("forgets a cancelled request, so a later stop doesn't answer it", async () => {
    const host = fakeHost();
    const seen: Array<unknown> = [];
    const port = forkedPanePort("/opt/host.ts", host.fork);
    port.on("message", ({ data }) => seen.push(data));
    port.postMessage({ type: "pane.request", id: "a", request: REQUEST });
    port.postMessage({ type: "pane.cancel", id: "a" });
    host.children[0]!.emit("exit", 0, null);
    expect(seen).toEqual([]);
    expect(host.children[0]!.sent).toEqual([
      { type: "pane.request", id: "a", request: REQUEST },
      { type: "pane.cancel", id: "a" },
    ]);
  });
});

describe("browserHostEnv", () => {
  it("hands the host where things are and which browser, and none of the server's secrets", () => {
    expect(
      browserHostEnv({
        PATH: "/usr/bin",
        HOME: "/home/gram",
        GRAM_BROWSER_EXECUTABLE: "/usr/bin/chromium",
        GRAM_BROWSER_SANDBOX: "0",
        NODE_OPTIONS: "--inspect",
        GH_DEBUG: "1",
        GH_TOKEN: "invented-token",
        HTTPS_PROXY: "http://proxy.invalid:3128",
        GRAM_DECISION_HOOK_TOKEN: "invented-hook-token",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/gram",
      GRAM_BROWSER_EXECUTABLE: "/usr/bin/chromium",
      GRAM_BROWSER_SANDBOX: "0",
    });
  });
});
