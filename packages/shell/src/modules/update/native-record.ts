// The record a signed install writes just before it restarts into an update, read once at the next
// launch: still on the old version means Squirrel.Mac didn't apply it, and the user is told so
// instead of silently staying old.
import type { AppUpdateNotApplied } from "@gram/contracts";

import { parseVersion } from "./semver.ts";

export const NATIVE_RECORD_FILE = "native-update.json";
/** Bigger than any record; a larger file isn't one. */
export const NATIVE_RECORD_MAX_BYTES = 4096;
/** An older record is about a restart too long ago to explain this launch. */
export const NATIVE_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface NativeInstallRecord {
  readonly schema: 1;
  /** The version that quit to install. */
  readonly from: string;
  /** The version it quit for. */
  readonly to: string;
  /** Epoch ms of the restart. */
  readonly at: number;
}

export function serializeInstallRecord(record: NativeInstallRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** The record in `text`, or undefined for anything that isn't exactly one. */
export function parseInstallRecord(text: string): NativeInstallRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { schema, from, to, at } = value as Record<string, unknown>;
  if (
    schema !== 1 ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    !parseVersion(from) ||
    !parseVersion(to) ||
    typeof at !== "number" ||
    !Number.isSafeInteger(at)
  )
    return undefined;
  return { schema, from, to, at };
}

/**
 * What the last restart's record says about this launch: `applied` when Gram now runs the version
 * it restarted for, a not-applied notice when it still runs the version that quit, and `stale` for
 * a record about some other version or too long ago. Every outcome removes the record.
 */
export function judgeInstallRecord(
  record: NativeInstallRecord,
  currentVersion: string,
  now: number,
  logHint: string,
):
  | { readonly kind: "applied" | "stale" }
  | ({ readonly kind: "notApplied" } & AppUpdateNotApplied) {
  if (now - record.at > NATIVE_RECORD_MAX_AGE_MS || record.at - now > 60_000)
    return { kind: "stale" };
  if (record.to === currentVersion) return { kind: "applied" };
  if (record.from !== currentVersion) return { kind: "stale" };
  return {
    kind: "notApplied",
    version: record.to,
    reason: `Gram restarted but macOS kept ${currentVersion}. ${logHint}`,
  };
}
