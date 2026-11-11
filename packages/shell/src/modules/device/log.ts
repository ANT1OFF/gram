import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import type { DeviceRefusalReason } from "@gram/contracts";

/**
 * The person's own record of what a lent machine was asked: one line per request, in a file in
 * the app's data folder, which no lent folder may contain. No output is kept. Each line carries
 * a keyed hash of itself and of the line before, with the key in the keychain, so the activity
 * window can say when the file was edited. The count and last hash are handed back on every
 * append for the caller to keep with its authenticated settings: with them, lines cut off the
 * end show too.
 */

export interface DeviceLogEntry {
  /** Milliseconds since the epoch, by this machine's clock. */
  readonly time: number;
  readonly origin: string;
  readonly workspace: string;
  /** The thread's id and the title the server gave it, the server's word. */
  readonly thread: string;
  readonly threadTitle: string;
  /** The lent folder's real path. */
  readonly folder: string;
  readonly kind: "exec" | "read" | "list";
  /** The command exactly as asked, or the real path read or listed when it got that far. */
  readonly what: string;
  /** How it was answered: allowed, taken back by the server, or why it was refused. */
  readonly answer: "allowed" | "withdrawn" | DeviceRefusalReason;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut?: boolean;
}

/** Where a log stands: how many lines, and the last line's hash. */
export interface DeviceLogHead {
  readonly count: number;
  readonly mac: string;
}

const START = "gram-device-log-v1";

const macOf = (key: Buffer, previous: string, body: string): string =>
  createHmac("sha256", key).update(previous).update("\n").update(body).digest("hex");

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

export interface DeviceLogRead {
  /** The lines that check out, oldest first, up to the first that doesn't. */
  readonly entries: ReadonlyArray<DeviceLogEntry>;
  /** Every line checks out and, when a head was given, the file ends where it says. */
  readonly intact: boolean;
  readonly head: DeviceLogHead;
}

/** Reads a log and says whether it is as this app wrote it. A missing file is an empty log. */
export const readDeviceLog = async (
  file: string,
  key: Buffer,
  expected?: DeviceLogHead,
): Promise<DeviceLogRead> => {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = "";
  }
  const entries: Array<DeviceLogEntry> = [];
  let mac = START;
  let intact = text === "" || text.endsWith("\n");
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let body: unknown;
    let claimed: unknown;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("shape");
      [claimed, body] = parsed;
    } catch {
      intact = false;
      break;
    }
    if (typeof claimed !== "string" || typeof body !== "string") {
      intact = false;
      break;
    }
    if (!same(macOf(key, mac, body), claimed)) {
      intact = false;
      break;
    }
    try {
      entries.push(JSON.parse(body) as DeviceLogEntry);
    } catch {
      intact = false;
      break;
    }
    mac = claimed;
  }
  const head = { count: entries.length, mac };
  if (expected !== undefined && (expected.count !== head.count || !same(expected.mac, head.mac)))
    intact = false;
  return { entries, intact, head };
};

export interface DeviceLog {
  /** Adds a line and gives where the log now stands. Lines go in the order they were asked. */
  readonly append: (entry: DeviceLogEntry) => Promise<DeviceLogHead>;
  readonly head: () => DeviceLogHead;
  /** The log was found edited when it was opened; new lines continue from its last good one. */
  readonly foundEdited: boolean;
}

/**
 * Opens the log for appending. Lines from the first that doesn't check out are moved out of the
 * log into a file beside it and `foundEdited` says so, since a chain can't continue from a line
 * that can't be trusted.
 */
export const openDeviceLog = async (
  file: string,
  key: Buffer,
  expected?: DeviceLogHead,
): Promise<DeviceLog> => {
  const read = await readDeviceLog(file, key, expected);
  let head = read.head;
  if (!read.intact) {
    const good = read.entries.length;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const kept = text
      .split("\n")
      .filter((line) => line !== "")
      .slice(0, good);
    // What was there is kept beside the log for the person to look at.
    if (text !== "") await fs.writeFile(`${file}.edited`, text, { mode: 0o600 });
    await fs.writeFile(file, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  }
  let last: Promise<unknown> = Promise.resolve();
  return {
    append: (entry) => {
      const next = last.then(async () => {
        const body = JSON.stringify(entry);
        const mac = macOf(key, head.mac, body);
        await fs.appendFile(file, `${JSON.stringify([mac, body])}\n`, { mode: 0o600 });
        head = { count: head.count + 1, mac };
        return head;
      });
      // One failed write doesn't stop the next line from being tried.
      last = next.catch(() => undefined);
      return next;
    },
    head: () => head,
    foundEdited: !read.intact,
  };
};
