import { describe, expect, it } from "vitest";
import type { HostedDevice } from "@gram/shell/modules/device";
import {
  agentHomes,
  askColorsFor,
  confirmServerDialog,
  createDeviceHost,
  embeddingFromMessage,
  machineWord,
  type MadeDevice,
} from "./hosted-device.ts";

const fakeDevice = (log: Array<string>, name: string): MadeDevice => ({
  device: {
    close: async () => {
      log.push(`close ${name}`);
    },
  } as unknown as HostedDevice,
  end: () => log.push(`end ${name}`),
});

const settle = () => new Promise((later) => setTimeout(later, 5));

describe("the personal device in the main process", () => {
  it("reads only the server's embedding message", () => {
    expect(embeddingFromMessage({ type: "embedding", on: true })).toBe(true);
    expect(embeddingFromMessage({ type: "embedding", on: false })).toBe(false);
    for (const other of [null, "embedding", { type: "embedding" }, { type: "logLevel", on: true }])
      expect(embeddingFromMessage(other)).toBeNull();
  });

  it("is made only while the setting is on, and once the app is ready", async () => {
    const log: Array<string> = [];
    let made = 0;
    const { promise: ready, resolve: beReady } = Promise.withResolvers<void>();
    const host = createDeviceHost({
      ready: () => ready,
      make: async () => fakeDevice(log, `d${(made += 1)}`),
      failed: (error) => log.push(`failed ${String(error)}`),
    });
    expect(host.device()).toBeUndefined();
    host.setEmbedding(true);
    await settle();
    expect(made).toBe(0);
    beReady();
    await settle();
    expect(host.device()).toBeDefined();
    host.setEmbedding(false);
    await settle();
    expect(host.device()).toBeUndefined();
    expect(log).toEqual(["close d1", "end d1"]);
    host.setEmbedding(true);
    await settle();
    expect(made).toBe(2);
  });

  it("keeps none made after a quit, or after the setting went off while it was made", async () => {
    const log: Array<string> = [];
    const { promise: making, resolve: finish } = Promise.withResolvers<MadeDevice>();
    const host = createDeviceHost({
      ready: async () => undefined,
      make: () => making,
      failed: () => undefined,
    });
    host.setEmbedding(true);
    await settle();
    host.setEmbedding(false);
    finish(fakeDevice(log, "late"));
    await settle();
    expect(host.device()).toBeUndefined();
    expect(log).toEqual(["close late", "end late"]);

    const quitting = createDeviceHost({
      ready: async () => undefined,
      make: async () => fakeDevice(log, "q"),
      failed: () => undefined,
    });
    quitting.setEmbedding(true);
    await settle();
    await quitting.close();
    expect(quitting.device()).toBeUndefined();
    quitting.setEmbedding(false);
    quitting.setEmbedding(true);
    await settle();
    expect(quitting.device()).toBeUndefined();
    expect(log.slice(-2)).toEqual(["close q", "end q"]);
  });

  it("reports a device that didn't start, and tries again when the setting comes back", async () => {
    const failures: Array<unknown> = [];
    let attempts = 0;
    const host = createDeviceHost({
      ready: async () => undefined,
      make: async () => {
        attempts += 1;
        throw new Error("no");
      },
      failed: (error) => failures.push(error),
    });
    host.setEmbedding(true);
    await settle();
    expect(failures).toHaveLength(1);
    host.setEmbedding(false);
    host.setEmbedding(true);
    await settle();
    expect(attempts).toBe(2);
  });

  it("names the machine, the agents' homes and the ask's colours", () => {
    expect(machineWord("darwin")).toBe("this Mac");
    expect(machineWord("linux")).toBe("this computer");
    expect(
      agentHomes({ CLAUDE_CONFIG_DIR: "/opt/claude", CODEX_HOME: "relative", HOME: "/home/a" }),
    ).toEqual(process.platform === "win32" ? [] : ["/opt/claude"]);
    expect(askColorsFor({ background: "#000", foreground: "#fff" }, true)).toMatchObject({
      background: "#000",
      foreground: "#fff",
    });
  });
});

describe("the device across an update", () => {
  it("stops for the update, and comes back when the restarted server says the setting is on", async () => {
    const log: Array<string> = [];
    let made = 0;
    const host = createDeviceHost({
      ready: async () => undefined,
      make: async () => fakeDevice(log, `u${(made += 1)}`),
      failed: () => undefined,
    });
    host.setEmbedding(true);
    await settle();
    await host.stop();
    expect(host.device()).toBeUndefined();
    expect(log).toEqual(["close u1", "end u1"]);
    host.setEmbedding(true);
    await settle();
    expect(host.device()).toBeDefined();
    expect(made).toBe(2);
  });
});

describe("the sign-in dialog", () => {
  it("shows the server's name on one line, its hidden codes drawn as codes", () => {
    const dialog = confirmServerDialog({
      origin: "https://example.test",
      name: 'Gram".\n\nVerified: your company‮',
    });
    expect(dialog.message).toBe("Sign in to https://example.test?");
    const named = dialog.detail.split("\n").filter((line) => line.startsWith("The server names"));
    expect(named).toHaveLength(1);
    expect(named[0]).not.toContain("‮");
    expect(named[0]).toContain("Verified: your company");
    expect(dialog.detail).toContain("characters you can't see");
    expect(dialog.detail.split("\n")).toHaveLength(4);
    expect(confirmServerDialog({ origin: "https://a.test", name: "Example" }).detail).not.toContain(
      "can't see",
    );
    expect(dialog.defaultId).toBe(dialog.cancelId);
  });
});
