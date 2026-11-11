import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE_SETTINGS_MOST_BYTES,
  type DeviceSettings,
  EMPTY_DEVICE_SETTINGS,
  readDeviceSettings,
  writeDeviceSettings,
} from "./settings.ts";

let dir: string;
let file: string;
const key = randomBytes(32);

const settings: DeviceSettings = {
  v: 1,
  servers: [
    {
      origin: "https://gram.example.com",
      paused: false,
      workspaces: [
        {
          id: "w1",
          readOnly: false,
          folders: [
            {
              id: "f-0123456789abcdef",
              label: "app",
              path: "/home/ada/code/app",
              device: 2049,
              inode: 1234,
              fullEnvironment: false,
            },
          ],
        },
      ],
    },
  ],
  log: { count: 3, mac: "ab".repeat(32) },
};

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "gram-settings-"));
  file = join(dir, "lending.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the lending settings", () => {
  it("are empty before anything is lent", async () => {
    expect(await readDeviceSettings(file, key)).toEqual({
      ok: true,
      settings: EMPTY_DEVICE_SETTINGS,
      fresh: true,
    });
  });

  it("read back as written, readable by this user alone", async () => {
    await writeDeviceSettings(file, key, settings);
    expect(await readDeviceSettings(file, key)).toEqual({
      ok: true,
      settings,
      logHead: settings.log,
    });
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o077).toBe(0);
    expect((await fs.readdir(dir)).toSorted()).toEqual(["lending.json"]);
  });

  it("are ignored when a command edits them, however it does", async () => {
    await writeDeviceSettings(file, key, settings);
    const text = await fs.readFile(file, "utf8");
    const { body, mac } = JSON.parse(text) as { body: string; mac: string };
    const wider = body.replace("/home/ada/code/app", "/home/ada");
    for (const edited of [
      JSON.stringify({ mac, body: wider }),
      JSON.stringify({ mac: "0".repeat(64), body: wider }),
      JSON.stringify({ body: wider }),
      "not json",
      "",
    ]) {
      await fs.writeFile(file, edited);
      expect(await readDeviceSettings(file, key), edited.slice(0, 40)).toMatchObject({
        ok: false,
        why: "edited",
      });
    }
    await fs.writeFile(file, text);
    expect(
      await readDeviceSettings(randomBytes(32).length ? file : file, randomBytes(32)),
    ).toMatchObject({
      ok: false,
    });
  });

  it("refuse a link or a shared file in their place", async () => {
    if (process.platform === "win32") return;
    await writeDeviceSettings(join(dir, "real.json"), key, settings);
    await fs.symlink(join(dir, "real.json"), file);
    expect(await readDeviceSettings(file, key)).toMatchObject({ ok: false, why: "edited" });
    await fs.rm(file);
    await fs.link(join(dir, "real.json"), file);
    expect(await readDeviceSettings(file, key)).toMatchObject({ ok: false, why: "edited" });
  });

  it("are refused when signed with the right key but shaped wrong", async () => {
    await writeDeviceSettings(file, key, settings);
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ v: 2, servers: [] });
    const mac = createHmac("sha256", key)
      .update("gram-device-settings-v1\n")
      .update(body)
      .digest("hex");
    await fs.writeFile(file, JSON.stringify({ mac, body }));
    expect(await readDeviceSettings(file, key)).toMatchObject({ ok: false, why: "edited" });
  });

  it("are refused, unread, when far larger than the app writes them", async () => {
    await fs.writeFile(file, " ".repeat(DEVICE_SETTINGS_MOST_BYTES + 1));
    expect(await readDeviceSettings(file, key)).toEqual({ ok: false, why: "edited" });
  });
});
