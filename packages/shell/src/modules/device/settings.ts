import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Schema from "effect/Schema";
import type { DeviceLogHead } from "./log.ts";

/**
 * The lending settings: which folders are lent to which workspace on which server, whether a
 * server is paused, and where the local log stood. One file, authenticated with a key from the
 * keychain, in the app's own data folder, which no lent folder may contain. A file that fails the
 * check is ignored and lending is off, so a command that edits the file can't lend more than the
 * person did. Whether lending is on is never kept: it turns off when the app quits.
 */

const LentFolderSetting = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^f-[a-f0-9]{16}$/)),
  label: Schema.String.check(Schema.isMaxLength(128)),
  path: Schema.String.check(Schema.isMaxLength(4096)),
  device: Schema.Number,
  inode: Schema.Number,
  /** The person chose, in the lending sheet, to pass this folder's commands the whole environment. */
  fullEnvironment: Schema.Boolean,
});

const WorkspaceSetting = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  folders: Schema.Array(LentFolderSetting).check(Schema.isMaxLength(32)),
  /** The person allowed only reads here, whatever the organisation allows. */
  readOnly: Schema.Boolean,
});

const ServerSetting = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(512)),
  workspaces: Schema.Array(WorkspaceSetting).check(Schema.isMaxLength(64)),
  paused: Schema.Boolean,
});

export const DeviceSettings = Schema.Struct({
  v: Schema.Literal(1),
  servers: Schema.Array(ServerSetting).check(Schema.isMaxLength(16)),
  log: Schema.optionalKey(
    Schema.Struct({
      count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      mac: Schema.String,
    }),
  ),
});
export type DeviceSettings = typeof DeviceSettings.Type;

export const EMPTY_DEVICE_SETTINGS: DeviceSettings = { v: 1, servers: [] };

export type DeviceSettingsRead =
  | { readonly ok: true; readonly settings: DeviceSettings; readonly logHead?: DeviceLogHead }
  /** No file yet: nothing is lent. */
  | { readonly ok: true; readonly settings: DeviceSettings; readonly fresh: true }
  /** The file is there and isn't as this app wrote it: lending is off until the person decides. */
  | { readonly ok: false; readonly why: "edited" | "unreadable" };

const macOf = (key: Buffer, body: string): string =>
  createHmac("sha256", key).update("gram-device-settings-v1\n").update(body).digest("hex");

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Reads the settings, and says when they aren't as this app wrote them. */
export const readDeviceSettings = async (
  file: string,
  key: Buffer,
): Promise<DeviceSettingsRead> => {
  let text: string;
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1) return { ok: false, why: "edited" };
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, settings: EMPTY_DEVICE_SETTINGS, fresh: true };
    return {
      ok: false,
      why: (error as NodeJS.ErrnoException).code === "ELOOP" ? "edited" : "unreadable",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: "edited" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("mac" in parsed) ||
    !("body" in parsed) ||
    typeof parsed.mac !== "string" ||
    typeof parsed.body !== "string" ||
    !same(macOf(key, parsed.body), parsed.mac)
  )
    return { ok: false, why: "edited" };
  let body: unknown;
  try {
    body = JSON.parse(parsed.body);
  } catch {
    return { ok: false, why: "edited" };
  }
  const decoded = Schema.decodeUnknownOption(DeviceSettings)(body);
  if (decoded._tag === "None") return { ok: false, why: "edited" };
  const settings = decoded.value;
  return settings.log === undefined
    ? { ok: true, settings }
    : { ok: true, settings, logHead: settings.log };
};

/**
 * Writes the settings whole: to a new file beside them, then renamed over them, so a crash leaves
 * the old ones or the new ones and never half of either. Readable by this user alone.
 */
export const writeDeviceSettings = async (
  file: string,
  key: Buffer,
  settings: DeviceSettings,
): Promise<void> => {
  const body = JSON.stringify(Schema.encodeSync(DeviceSettings)(settings));
  const text = JSON.stringify({ mac: macOf(key, body), body });
  const next = join(dirname(file), `.${randomBytes(8).toString("hex")}.settings-next`);
  await fs.writeFile(next, text, { mode: 0o600, flag: "wx" });
  try {
    await fs.rename(next, file);
  } catch (error) {
    await fs.rm(next, { force: true });
    throw error;
  }
};
