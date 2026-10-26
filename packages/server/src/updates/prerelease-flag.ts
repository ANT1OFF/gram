import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { UpdateChannel } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { Logger as PinoLogger } from "pino";

export const PREFS_FILE = "prefs.json";
export const PRERELEASE_KEY = "gram.updatePrerelease";
/**
 * Gram's pinned version, for the desktop shell to check an install against.
 */
export const PIN_KEY = "gram.updatePinnedVersion";
/** The update settings `prefs.json` mirrors: the channel, and the pin while there is one. */
export interface UpdatePrefs {
  readonly channel: UpdateChannel;
  readonly automaticChecks?: boolean | undefined;
  readonly pinnedVersion?: string | undefined;
}

/**
 * Mirrors the release channel into Gram's `<dataDir>/prefs.json` as the `PRERELEASE_KEY` flag:
 * `"1"` on prerelease, absent on stable. The pin goes in `PIN_KEY`, absent without one.
 * Other keys are kept, and the file is replaced atomically.
 * A file that isn't a JSON object is left alone and the promise rejects.
 */
export async function writeUpdatePrefs(dataDir: string, updates: UpdatePrefs): Promise<void> {
  const path = join(dataDir, PREFS_FILE);
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path} is not a JSON object`);
    }
    prefs = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (updates.channel === "prerelease") prefs[PRERELEASE_KEY] = "1";
  else Reflect.deleteProperty(prefs, PRERELEASE_KEY);
  if (updates.pinnedVersion === undefined) Reflect.deleteProperty(prefs, PIN_KEY);
  else prefs[PIN_KEY] = updates.pinnedVersion;

  if (updates.automaticChecks === true) prefs["gram.automaticUpdateChecks"] = true;
  else Reflect.deleteProperty(prefs, "gram.automaticUpdateChecks");

  await mkdir(dataDir, { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * The update settings Gram's `<dataDir>/prefs.json` mirrors: `prerelease` when the flag is `"1"`,
 * else `stable`, including when the file is missing or unreadable, which also means no pin.
 */
export async function readUpdatePrefs(dataDir: string): Promise<UpdatePrefs> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dataDir, PREFS_FILE), "utf8"));
    const prefs =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const channel = prefs[PRERELEASE_KEY] === "1" ? "prerelease" : "stable";
    const pin = prefs[PIN_KEY];
    return {
      channel,
      ...(typeof pin === "string" ? { pinnedVersion: pin } : {}),
      ...(prefs["gram.automaticUpdateChecks"] === true ? { automaticChecks: true } : {}),
    };
  } catch {
    // No prefs yet, or garbage: no flag means stable.
    return { channel: "stable" };
  }
}

/** The channel mirrored in Gram's `<dataDir>/prefs.json`. */
export async function readPrereleaseChannel(dataDir: string): Promise<UpdateChannel> {
  return (await readUpdatePrefs(dataDir)).channel;
}

const writers = new Map<string, (updates: UpdatePrefs) => Promise<void>>();

/**
 * Serialises `writeUpdatePrefs` calls with one queue per data dir, shared by every caller, so the
 * last settings set are the ones on disk.
 */
export function updatePrefsWriter(dataDir: string): (updates: UpdatePrefs) => Promise<void> {
  const existing = writers.get(dataDir);
  if (existing) return existing;
  let queue: Promise<void> = Promise.resolve();
  const write = (updates: UpdatePrefs) => {
    const next = queue.then(() => writeUpdatePrefs(dataDir, updates));
    queue = next.catch(() => {});
    return next;
  };
  writers.set(dataDir, write);
  return write;
}

/** Mirrors update settings through the shared writer. A failed write is logged, never surfaced. */
export const mirrorUpdatePrefs =
  (dataDir: string, logger: PinoLogger) =>
  (updates: UpdatePrefs): Effect.Effect<void> =>
    Effect.promise(() =>
      updatePrefsWriter(dataDir)(updates).catch((error: unknown) => {
        logger.warn({ err: error }, "mirror the update prefs");
      }),
    );
