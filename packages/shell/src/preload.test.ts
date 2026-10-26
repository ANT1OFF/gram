import { describe, expect, it, vi } from "vitest";

import { Channels } from "./channels.ts";
import {
  composeBridge,
  connectionPreload,
  fontsPreload,
  speechPreload,
  trayPreload,
  type PreloadIpc,
} from "./preload.ts";

/** A `PreloadIpc` whose calls are recorded. */
const fakeIpc = () => {
  const invoke = vi.fn<(channel: string, arg?: unknown) => Promise<unknown>>(async () => undefined);
  const send = vi.fn<(channel: string, arg?: unknown) => void>();
  const subscribe = vi.fn<(channel: string, callback: (value: unknown) => void) => () => void>(
    () => () => {},
  );
  const subscribeWithPorts = vi.fn<
    (
      channel: string,
      callback: (value: unknown, ports: readonly MessagePort[]) => void,
    ) => () => void
  >(() => () => {});
  const ipc: PreloadIpc = {
    invoke: invoke as PreloadIpc["invoke"],
    send,
    subscribe: subscribe as PreloadIpc["subscribe"],
    subscribeWithPorts: subscribeWithPorts as PreloadIpc["subscribeWithPorts"],
  };
  return { ipc, invoke, send, subscribe, subscribeWithPorts };
};

describe("composeBridge", () => {
  it("joins the base and each module's members", () => {
    const { ipc } = fakeIpc();
    const bridge = composeBridge({ platform: "linux" }, fontsPreload(ipc), connectionPreload(ipc));
    expect(Object.keys(bridge).toSorted()).toEqual(["listFonts", "platform", "reportConnection"]);
  });

  it("refuses a member given twice, rather than letting one win unseen", () => {
    const { ipc } = fakeIpc();
    expect(() => composeBridge(fontsPreload(ipc), { listFonts: async () => [] })).toThrow(
      "listFonts is given twice",
    );
  });
});

describe("the modules' bridge halves", () => {
  it("call their own channels", async () => {
    const { ipc, invoke, send } = fakeIpc();
    await fontsPreload(ipc).listFonts?.();
    connectionPreload(ipc).reportConnection?.({ status: "open" });
    expect(invoke).toHaveBeenCalledWith(Channels.listFonts);
    expect(send).toHaveBeenCalledWith(Channels.connectionState, { status: "open" });
  });

  it("offer the tray on every platform, and send its menu and hear its picks on their own channels", async () => {
    const { ipc, invoke, send, subscribe } = fakeIpc();
    const { keepInTray, tray } = trayPreload(ipc);
    await keepInTray!.set(true);
    keepInTray!.onChange(() => {});
    expect(invoke).toHaveBeenCalledWith(Channels.keepInTraySet, true);
    expect(subscribe).toHaveBeenCalledWith(Channels.keepInTrayChanged, expect.any(Function));
    const menu = { asks: [], more: 0, workspaces: [] };
    tray!.show(menu);
    tray!.onAction(() => {});
    expect(send).toHaveBeenCalledWith(Channels.trayMenu, menu);
    expect(subscribe).toHaveBeenCalledWith(Channels.trayAction, expect.any(Function));
  });

  it("listen for speech ports and crashes before the page can open a session", async () => {
    const { ipc, invoke, subscribe, subscribeWithPorts } = fakeIpc();
    const window = { postMessage: vi.fn(), location: { origin: "http://127.0.0.1:1" } };
    const { speech } = speechPreload(ipc, window);
    expect(subscribeWithPorts).toHaveBeenCalledWith(Channels.speechPort, expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith(Channels.speechCrashed, expect.any(Function));
    await speech?.prewarm("model", "balanced");
    expect(invoke).toHaveBeenCalledWith(Channels.speechPrewarm, {
      modelId: "model",
      performance: "balanced",
    });
  });
});
