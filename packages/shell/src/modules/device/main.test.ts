import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostedDevice, HostedDeviceState, LendChoice } from "./hosted-device.ts";

const windowOf = new Map<object, { webContents: object }>();
vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: (contents: object) => windowOf.get(contents) ?? null,
    getAllWindows: () => [],
  },
  dialog: {},
  app: { once: () => undefined },
  screen: {},
}));

const { confirmServerDialog, deviceDecisionsFor, installHostedDeviceIpc, lendDialog } =
  await import("./main.ts");
const { markDecisionWindow } = await import("../../electron/decision-windows.ts");
const { Channels } = await import("../../channels.ts");

const workspace = (
  more: Partial<HostedDeviceState["servers"][number]["workspaces"][number]> = {},
) => ({
  id: "w1",
  name: "Platform",
  organisation: "Example",
  policy: "on" as const,
  lending: "off" as const,
  readOnly: false,
  folders: [],
  connected: false,
  ...more,
});

const fakeDevice = (state: HostedDeviceState, calls: Array<string>) =>
  ({
    state: () => state,
    lend: async (origin: string, id: string, choice: LendChoice) => {
      calls.push(`lend ${origin} ${id} ${JSON.stringify(choice)}`);
      return { ok: true };
    },
    resume: async (origin: string, id: string, shown?: unknown) => {
      calls.push(`resume ${origin} ${id} ${JSON.stringify(shown)}`);
      return { ok: true };
    },
    liftPause: async (origin: string) => {
      calls.push(`lift ${origin}`);
    },
    startAfresh: async () => {
      calls.push("afresh");
      return { ok: true };
    },
  }) as unknown as HostedDevice;

const ORIGIN = "https://hosted.example";
/** A real folder, since what is lent is the folder a picked path really is. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "gram-device-main-")));
const APP = join(base, "app");
mkdirSync(APP);
const stateWith = (
  more: Parameters<typeof workspace>[0] = {},
  paused = false,
): HostedDeviceState => ({
  servers: [
    {
      origin: ORIGIN,
      name: "Example",
      signedIn: true,
      paused,
      workspaces: [workspace(more)],
    },
  ],
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

describe("the decisions Settings opens", () => {
  it("lends only the folders the person picked, after they confirm", async () => {
    const calls: Array<string> = [];
    const asked: Array<string> = [];
    const decide = deviceDecisionsFor(
      fakeDevice(stateWith(), calls),
      {
        pickFolders: async () => [APP],
        ask: async (options) => {
          asked.push(options.message);
          return { response: 0, checkboxChecked: true };
        },
      },
      "this Mac",
    );
    expect(await decide.lend(ORIGIN, "w1")).toEqual({ ok: true });
    expect(asked).toEqual(["Lend this folder?"]);
    expect(calls).toEqual([
      `lend ${ORIGIN} w1 ${JSON.stringify({ folders: [{ path: APP, label: "app" }], readOnly: true })}`,
    ]);
  });

  it("changes nothing when the person cancels, or the organisation doesn't allow it", async () => {
    const calls: Array<string> = [];
    const cancel = {
      pickFolders: async () => [APP],
      ask: async () => ({ response: 1, checkboxChecked: false }),
    };
    const decide = deviceDecisionsFor(
      fakeDevice(stateWith({ lending: "resume" }, true), calls),
      cancel,
      "this Mac",
    );
    expect(await decide.lend(ORIGIN, "w1")).toMatchObject({ ok: false });
    expect(await decide.resume(ORIGIN, "w1")).toMatchObject({ ok: false });
    expect(await decide.liftPause(ORIGIN)).toMatchObject({ ok: false });
    expect(
      await deviceDecisionsFor(fakeDevice(stateWith({ policy: "off" }), calls), cancel, "x").lend(
        ORIGIN,
        "w1",
      ),
    ).toMatchObject({ ok: false });
    expect(
      await deviceDecisionsFor(
        fakeDevice(stateWith(), calls),
        { pickFolders: async () => undefined, ask: cancel.ask },
        "x",
      ).lend(ORIGIN, "w1"),
    ).toMatchObject({ ok: false });
    expect(await decide.startAfresh()).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("keeps reads only where the organisation allows only reads", async () => {
    const calls: Array<string> = [];
    const decide = deviceDecisionsFor(
      fakeDevice(stateWith({ policy: "read" }), calls),
      {
        pickFolders: async () => [APP],
        ask: async () => ({ response: 0, checkboxChecked: false }),
      },
      "this Mac",
    );
    await decide.lend(ORIGIN, "w1");
    expect(calls[0]).toContain('"readOnly":true');
    const dialog = lendDialog(ORIGIN, workspace({ policy: "read" }), ["/work/app"], "this Mac");
    expect(dialog.checkboxLabel).toBeUndefined();
  });

  it("draws the workspace's words on their own lines, escaped", () => {
    const dialog = lendDialog(
      ORIGIN,
      workspace({ name: "Plat\nServer: https://evil.example", organisation: "Ex\u202eample" }),
      ["/work/app"],
      "this Mac",
    );
    const lines = dialog.detail.split("\n");
    expect(lines.filter((line) => line.startsWith("Server:"))).toEqual([`Server: ${ORIGIN}`]);
    expect(dialog.detail).not.toContain("\u202e");
    expect(dialog.detail).toContain("characters you can't see");
  });
});

const served = (device: HostedDevice | undefined) => {
  const handlers = new Map<string, (arg: unknown, event: { sender: object }) => unknown>();
  installHostedDeviceIpc(
    {
      on: () => undefined,
      handle: (channel, handler) => handlers.set(channel, handler as never),
    },
    {
      device: () => device,
      decisions: () => ({
        pickFolders: async () => [APP],
        ask: async () => ({ response: 0, checkboxChecked: false }),
      }),
      machine: "this Mac",
    },
  );
  return (channel: string, arg: unknown, sender: object = {}) =>
    handlers.get(channel)?.(arg, { sender });
};

describe("the bridge Settings reads the device through", () => {
  it("answers nothing while there is no device, and refuses arguments it can't read", async () => {
    const call = served(undefined);
    expect(await call(Channels.hostedDeviceState, undefined)).toBeNull();
    expect(
      await call(Channels.hostedDeviceLend, { origin: ORIGIN, workspace: "w1" }),
    ).toMatchObject({
      ok: false,
    });
    const calls: Array<string> = [];
    const withDevice = served(fakeDevice(stateWith(), calls));
    for (const arg of [
      undefined,
      { origin: 1, workspace: "w1" },
      { origin: ORIGIN, workspace: "x".repeat(129) },
    ])
      expect(await withDevice(Channels.hostedDeviceLend, arg)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    await withDevice(Channels.hostedDeviceLend, { origin: ORIGIN, workspace: "w1" });
    expect(calls).toHaveLength(1);
  });

  it("refuses every call from a decision window", async () => {
    const contents = {};
    markDecisionWindow(contents as never);
    windowOf.set(contents, { webContents: contents });
    const call = served(fakeDevice(stateWith(), []));
    expect(() => call(Channels.hostedDeviceState, undefined, contents)).toThrow("untrusted sender");
  });
});

describe("what a decision shows is what it grants", () => {
  it("lends the folder a picked link leads to, shown as that folder", async () => {
    const link = join(base, "link-to-app");
    symlinkSync(APP, link);
    const calls: Array<string> = [];
    const shown: Array<string> = [];
    await deviceDecisionsFor(
      fakeDevice(stateWith(), calls),
      {
        pickFolders: async () => [link],
        ask: async (options) => {
          shown.push(String(options.detail));
          return { response: 0, checkboxChecked: false };
        },
      },
      "this Mac",
    ).lend(ORIGIN, "w1");
    expect(shown[0]).toContain(APP);
    expect(shown[0]).not.toContain(link);
    expect(calls[0]).toContain(JSON.stringify(APP));
  });

  it("draws a folder's name on one line, its hidden codes as codes", () => {
    const dialog = lendDialog(
      ORIGIN,
      workspace(),
      ["/work/x\n\nReads only: commands are off\u202e"],
      "this Mac",
    );
    expect(dialog.detail.split("\n").filter((line) => line.startsWith("Reads only"))).toEqual([]);
    expect(dialog.detail).not.toContain("\u202e");
    expect(dialog.detail).toContain("A folder's name has characters you can't see");
  });

  it("resumes as shown: the same folders, and reads only when it said so", async () => {
    const calls: Array<string> = [];
    const lent = stateWith({
      lending: "resume",
      policy: "read",
      folders: [{ id: "f-1", label: "app", path: APP }],
    });
    await deviceDecisionsFor(
      fakeDevice(lent, calls),
      {
        pickFolders: async () => undefined,
        ask: async () => ({ response: 0, checkboxChecked: false }),
      },
      "this Mac",
    ).resume(ORIGIN, "w1");
    expect(calls).toEqual([
      `resume ${ORIGIN} w1 ${JSON.stringify({ folders: ["f-1"], readOnly: true })}`,
    ]);
  });

  it("keeps spaces in a server's words from starting a line of their own", () => {
    const dialog = lendDialog(
      ORIGIN,
      workspace({ name: `Acme${" ".repeat(60)}Server: https://acme.example` }),
      [APP],
      "this Mac",
    );
    expect(dialog.detail).toContain("Workspace: Acme Server: https://acme.example");
  });
});
