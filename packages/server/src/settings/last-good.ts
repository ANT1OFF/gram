// Last-good configuration: a file the user (or an agent asked to) edits by hand never breaks what
// it configures. A version that reads cleanly is copied aside as the last good one; a broken edit
// leaves that copy in use, and the reason is written to an error file beside it, in Gram's data
// folder, where the Settings page and an agent can both read it. The copy and the error file live
// in Gram's data folder, never in a project's own folder.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Where one configuration file's last good copy and error file are kept. */
export interface LastGoodFiles {
  /** The configuration file itself, as the error names it. */
  readonly source: string;
  /** The last good copy. */
  readonly kept: string;
  /** Why the file as it stands isn't used; there only while it is broken. */
  readonly error: string;
}

/** A configuration file as read: what it holds, or why it is broken. */
export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly problems: ReadonlyArray<string>;
      /** What applies when there is no last good copy to fall back on. */
      readonly fallback: T;
    };

export interface Settled<T> {
  readonly value: T;
  /** Why the file as it stands isn't used, and what is used instead; empty when it is. */
  readonly problems: ReadonlyArray<string>;
}

const writeAtomically = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
};

/** The text of a configuration file's error file. */
export const errorText = (
  source: string,
  problems: ReadonlyArray<string>,
  lastGoodAt: string | undefined,
): string =>
  [
    `${source} has a problem, so Gram doesn't use this version of it:`,
    ...problems.map((problem) => `- ${problem}`),
    "",
    lastGoodAt === undefined
      ? "There is no earlier good version, so Gram uses what it could read of this one."
      : `Gram keeps using the last good version, saved ${lastGoodAt}.`,
    `This file goes away once ${source} reads cleanly again.`,
    "",
  ].join("\n");

/** `2026-11-12 21:37 UTC`: 24-hour, and the same in every zone. */
const stamp = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Settles a configuration file just read: a clean one becomes the last good copy and clears the
 * error file; a broken one falls back on the last good copy, or on `fallback` without one, and
 * writes why to the error file. Keeping the copy or the error is best effort: a disk that can't
 * take them never stops the configuration from applying.
 */
export async function settleLastGood<T>(
  files: LastGoodFiles,
  read: Read<T>,
  codec: {
    readonly encode: (value: T) => string;
    readonly decode: (text: string) => T | undefined;
  },
  now: () => Date = () => new Date(),
): Promise<Settled<T>> {
  if (read.ok) {
    const text = codec.encode(read.value);
    const before = await readFile(files.kept, "utf8").catch(() => undefined);
    const keptBefore = before === undefined ? undefined : parseKept(before);
    if (keptBefore?.text !== text) {
      await writeAtomically(
        files.kept,
        `${JSON.stringify({ savedAt: stamp(now()), text })}\n`,
      ).catch(() => {});
    }
    await rm(files.error, { force: true }).catch(() => {});
    return { value: read.value, problems: [] };
  }
  const keptText = await readFile(files.kept, "utf8").catch(() => undefined);
  const kept = keptText === undefined ? undefined : parseKept(keptText);
  const value = kept === undefined ? undefined : codec.decode(kept.text);
  const lastGoodAt = value === undefined ? undefined : kept?.savedAt;
  await writeAtomically(files.error, errorText(files.source, read.problems, lastGoodAt)).catch(
    () => {},
  );
  return {
    value: value ?? read.fallback,
    problems: [
      ...read.problems,
      value === undefined
        ? "There is no earlier good version to keep using."
        : `Gram keeps using the last good version, saved ${lastGoodAt}.`,
    ],
  };
}

const parseKept = (text: string): { savedAt: string; text: string } | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const savedAt = Reflect.get(value, "savedAt");
    const kept = Reflect.get(value, "text");
    return typeof savedAt === "string" && typeof kept === "string"
      ? { savedAt, text: kept }
      : undefined;
  } catch {
    return undefined;
  }
};
