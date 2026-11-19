import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { HOST_MODE_FLAG } from "@gram/server/host/launch-args";

/** The same file, however its path is spelled; false when either can't be found. */
const same = (a: string, b: string) => {
  if (resolve(a) === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Which of the files the app ships its first argument asks it to run: its `host` (by its path or
 * `--gram-host`) or its native `probe`, or undefined for the app itself. Never any other file.
 */
export const shippedTarget = (
  first: string | undefined,
  host: string,
  probe: string,
): string | undefined => {
  if (first === undefined) return undefined;
  if (first === HOST_MODE_FLAG || same(first, host)) return host;
  if (same(first, probe)) return probe;
  return undefined;
};
