import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { dateKey, localWall, plusDays } from "../zone-time.ts";
import { redactText } from "./redact.ts";

/** `yyyy-mm-dd` in local time, which is how people remember when something happened. */
export const localDay = (date: Date): string => dateKey(localWall(date));

export const logFileName = (name: string, date: Date): string => `${name}-${localDay(date)}.log`;

const dayOf = (name: string, file: string): string | undefined => {
  const match = /^(.+)-(\d{4}-\d{2}-\d{2})\.log$/.exec(file);
  return match?.[1] === name ? match[2] : undefined;
};

export interface DailyFileOptions {
  readonly dir: string;
  /** File prefix: `<name>-<yyyy-mm-dd>.log`. */
  readonly name: string;
  /** Files dated more than this many days before today are removed when a new day's file opens. */
  readonly retainDays?: number;
  readonly now?: () => Date;
  /** Receives each redacted line as well (development echo to stdout). */
  readonly echo?: (line: string) => void;
}

export interface DailyFile {
  write(chunk: string): boolean;
  close(): void;
}

/**
 * A pino destination appending redacted lines to one file per local day. Writes are synchronous so
 * a crash keeps the lines before it. A file that can't be opened or written is skipped for the rest
 * of that day: logging never takes the process down.
 */
export function dailyFile(options: DailyFileOptions): DailyFile {
  const { dir, name, retainDays = 7, now = () => new Date(), echo } = options;
  let day = "";
  let fd: number | undefined;
  let failedDay = "";

  const close = () => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      // Already closed or gone; nothing to flush.
    }
    fd = undefined;
  };

  return {
    write(chunk) {
      const line = redactText(chunk);
      echo?.(line);
      const date = now();
      const today = localDay(date);
      if (today === failedDay) return true;
      try {
        if (fd === undefined || today !== day) {
          close();
          mkdirSync(dir, { recursive: true });
          fd = openSync(join(dir, logFileName(name, date)), "a");
          day = today;
          pruneLogs(dir, name, date, retainDays);
        }
        writeSync(fd, line);
      } catch {
        close();
        failedDay = today;
      }
      return true;
    },
    close,
  };
}

/**
 * Removes `<name>-<day>.log` files dated more than `retainDays` calendar days before `now`'s local
 * date. Counted in dates, not hours: a week that holds a daylight-saving change is 167 or 169 hours.
 */
export function pruneLogs(dir: string, name: string, now: Date, retainDays: number): void {
  const cutoff = dateKey(plusDays(localWall(now), -retainDays));
  try {
    for (const file of readdirSync(dir)) {
      const fileDay = dayOf(name, file);
      if (fileDay !== undefined && fileDay < cutoff) rmSync(join(dir, file), { force: true });
    }
  } catch {
    // A missing or unreadable dir has nothing to prune.
  }
}

/** The newest `<name>-<day>.log` in `dir`, if any. */
export function latestLogFile(dir: string, name: string): string | undefined {
  try {
    const files = readdirSync(dir)
      .filter((file) => dayOf(name, file) !== undefined)
      .toSorted();
    const newest = files.at(-1);
    return newest === undefined ? undefined : join(dir, newest);
  } catch {
    return undefined;
  }
}

/** The last `count` non-empty lines of `file`, reading at most its final `maxBytes`. */
export function tailLines(file: string, count: number, maxBytes = 1_048_576): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const { size } = fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    // Reading from the middle of the file cuts the first line short.
    if (length < size) lines.shift();
    return lines.filter((line) => line !== "").slice(-count);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
