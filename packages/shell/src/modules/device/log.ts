import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { DeviceRefusalReason } from "@gram/contracts";

/**
 * The person's own record of what a lent machine was asked: one line per request, in a file in
 * the app's data folder, which no lent folder may contain. No output is kept. Each line carries
 * a keyed hash of itself and of the line before, with the key in the keychain, so the activity
 * window can say when the file was edited. The count and last hash are handed back on every
 * append for the caller to keep with its authenticated settings: with them, lines cut off the
 * end show too, and lines added after them (a crash before the head was kept) don't count as an
 * edit.
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
  /**
   * Every line checks out and, when a head was given, the chain passes through it: the file
   * has at least those lines, and the one at its count has its hash. Lines after it are what
   * was written after the head was last kept, as after a crash.
   */
  readonly intact: boolean;
  readonly head: DeviceLogHead;
  /** How many bytes of the file the good lines take. */
  readonly goodBytes: number;
}

const parseLines = (
  text: string,
  key: Buffer,
): { entries: Array<DeviceLogEntry>; macs: Array<string>; goodBytes: number; clean: boolean } => {
  const entries: Array<DeviceLogEntry> = [];
  const macs: Array<string> = [START];
  let goodBytes = 0;
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf("\n", at);
    // A last line without its newline was never finished.
    if (end === -1) return { entries, macs, goodBytes, clean: false };
    const line = text.slice(at, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { entries, macs, goodBytes, clean: false };
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      // Byte for byte as the app writes it: no spaces, blank lines or other spellings.
      JSON.stringify(parsed) !== line
    )
      return { entries, macs, goodBytes, clean: false };
    const [claimed, body] = parsed as [string, string];
    if (!same(macOf(key, macs.at(-1) ?? START, body), claimed))
      return { entries, macs, goodBytes, clean: false };
    let entry: DeviceLogEntry;
    try {
      entry = JSON.parse(body) as DeviceLogEntry;
    } catch {
      return { entries, macs, goodBytes, clean: false };
    }
    entries.push(entry);
    macs.push(claimed);
    at = end + 1;
    goodBytes = Buffer.byteLength(text.slice(0, at), "utf8");
  }
  return { entries, macs, goodBytes, clean: true };
};

const judge = (text: string, key: Buffer, expected: DeviceLogHead | undefined): DeviceLogRead => {
  const { entries, macs, goodBytes, clean } = parseLines(text, key);
  const head = { count: entries.length, mac: macs.at(-1) ?? START };
  let intact = clean;
  if (expected !== undefined) {
    const there = macs[expected.count];
    if (there === undefined || !same(there, expected.mac)) intact = false;
  }
  return { entries, intact, head, goodBytes };
};

/**
 * Reads a log and says whether it is as this app wrote it. A missing file is an empty log, which
 * is only intact when no head says otherwise. Always pass the kept head when there is one:
 * without it, lines cut off the end can't show.
 */
export const readDeviceLog = async (
  file: string,
  key: Buffer,
  expected?: DeviceLogHead,
): Promise<DeviceLogRead> => {
  let text: string;
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = "";
  }
  return judge(text, key, expected);
};

export interface DeviceLog {
  /** Adds a line and gives where the log now stands. Lines go in the order they were asked. */
  readonly append: (entry: DeviceLogEntry) => Promise<DeviceLogHead>;
  readonly head: () => DeviceLogHead;
  /**
   * The log was found edited when it was opened: what was there is kept in `setAside`, and new
   * lines continue from its last good line.
   */
  readonly foundEdited: boolean;
  readonly setAside: string | undefined;
  readonly close: () => Promise<void>;
}

/**
 * Opens the log for appending, through one handle held until `close`. The file must be a regular
 * file of this user's with one link, not a link: anything else is refused rather than written
 * through. It is kept readable by this user alone.
 *
 * A file that doesn't check out is copied, whole, to a new file beside it that is never
 * overwritten, and the log is cut back to its last good line. A write that fails is cut back
 * the same way before the next one, so one failure doesn't break the chain for every later line.
 * Only one app may hold a log open at a time; the caller makes sure of that.
 */
export const openDeviceLog = async (
  file: string,
  key: Buffer,
  expected?: DeviceLogHead,
): Promise<DeviceLog> => {
  const handle = await fs.open(
    file,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let head: DeviceLogHead;
  let goodBytes: number;
  let setAside: string | undefined;
  let foundEdited: boolean;
  try {
    const stats = await handle.stat();
    const ownUser = typeof process.getuid === "function" ? process.getuid() : stats.uid;
    if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== ownUser)
      throw new Error("The device log isn't a file Gram can trust.");
    await handle.chmod(0o600);
    const text = await handle.readFile("utf8");
    const read = judge(text, key, expected);
    head = read.head;
    goodBytes = read.goodBytes;
    foundEdited = !read.intact;
    if (!read.intact) {
      if (text !== "") {
        setAside = `${file}.edited-${Date.now()}-${randomBytes(4).toString("hex")}`;
        await fs.writeFile(setAside, text, { mode: 0o600, flag: "wx" });
      }
      await handle.truncate(goodBytes);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  let last: Promise<unknown> = Promise.resolve();
  return {
    append: (entry) => {
      const next = last.then(async () => {
        const body = JSON.stringify(entry);
        const mac = macOf(key, head.mac, body);
        const line = Buffer.from(`${JSON.stringify([mac, body])}\n`, "utf8");
        try {
          let written = 0;
          while (written < line.length) {
            const { bytesWritten } = await handle.write(
              line,
              written,
              line.length - written,
              goodBytes + written,
            );
            if (bytesWritten === 0) throw new Error("The device log took no bytes.");
            written += bytesWritten;
          }
        } catch (error) {
          // Nothing of a line that didn't land whole stays to break the next.
          await handle.truncate(goodBytes).catch(() => undefined);
          throw error;
        }
        goodBytes += line.length;
        head = { count: head.count + 1, mac };
        return head;
      });
      // One failed write doesn't stop the next line from being tried.
      last = next.catch(() => undefined);
      return next;
    },
    head: () => head,
    foundEdited,
    setAside,
    close: async () => {
      await last;
      await handle.close();
    },
  };
};
