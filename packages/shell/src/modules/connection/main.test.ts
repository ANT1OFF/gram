import type { IpcMainEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { Channels } from "../../channels.ts";
import { SESSION_RENEW_INTERVAL_MS } from "../../core/renderer-health.ts";
import type { ShellIpc } from "../ipc.ts";
import { installConnection } from "./main.ts";

const setup = (renewSession?: (sender: WebContents) => boolean) => {
  let handler: ((event: IpcMainEvent, arg: unknown) => void) | undefined;
  const ipc: ShellIpc = {
    on: (channel, listener) => {
      if (channel === Channels.connectionState) handler = listener;
    },
    handle: () => {},
  };
  const lines: string[] = [];
  const sink = (_fields: Record<string, unknown>, message: string) => lines.push(message);
  const clock = { now: 0 };
  const sender = { id: 1 } as unknown as WebContents;
  const connection = installConnection(ipc, {
    log: { info: sink, warn: sink, error: sink },
    windowIdFor: (contents) => (contents === sender ? "w1" : undefined),
    ...(renewSession === undefined ? {} : { renewSession }),
    now: () => clock.now,
  });
  const report = (state: unknown, from: WebContents = sender) =>
    handler?.({ sender: from } as IpcMainEvent, state);
  return { report, lines, clock, connection, sender };
};

describe("installConnection", () => {
  // 1.23.0, 2026-11-13: Chromium's network service restarted under a running server, the launch
  // cookie went with it, and a 460 ms blip left the window on "Session expired" until Gram restarted.
  it("loads a window the server refused onto the boot address again, the blip it came in on", () => {
    const renew = vi.fn(() => true);
    const { report, lines, clock, sender } = setup(renew);
    report({ status: "open" });
    clock.now = 360_000;
    report({ status: "reconnecting", attempt: 1 });
    clock.now += 460;
    report({ status: "reconnecting", attempt: 2 });
    report({ status: "expired" });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith(sender);
    expect(lines).toEqual([
      "renderer lost its server connection",
      "renderer reconnecting",
      "renderer session expired",
      "renderer session renewed: reloaded onto the server's boot address",
    ]);
  });

  it("renews a window once per interval, so a server that keeps refusing can't loop it", () => {
    const renew = vi.fn(() => true);
    const { report, lines, clock } = setup(renew);
    report({ status: "expired" });
    clock.now += SESSION_RENEW_INTERVAL_MS - 1;
    report({ status: "expired" });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toBe(
      "renderer session expired again soon after it was renewed; leaving it",
    );
    clock.now += 1;
    report({ status: "expired" });
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("tries again at the next expiry when there was no server to load", () => {
    const renew = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const { report } = setup(renew);
    report({ status: "expired" });
    report({ status: "expired" });
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("renews nothing for other states, other pages, or a window that closed and came back", () => {
    const renew = vi.fn(() => true);
    const { report, connection } = setup(renew);
    report({ status: "reconnecting", attempt: 1 });
    report({ status: "open" });
    report({ status: "expired" }, { id: 2 } as unknown as WebContents);
    report({ status: "lost" });
    expect(renew).not.toHaveBeenCalled();
    report({ status: "expired" });
    connection.forget("w1");
    report({ status: "expired" });
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("only logs an expired session when it can't renew one", () => {
    const { report, lines } = setup();
    report({ status: "expired" });
    expect(lines).toEqual(["renderer session expired"]);
  });
});
