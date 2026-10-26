import { join } from "node:path";
import type { LogLevel } from "@gram/contracts";
import pino, { type Logger } from "pino";
import { dailyFile, type DailyFile } from "./daily-file.ts";
import { CENSOR } from "./redact.ts";

/** Structured fields pino censors at the top level and one level down. */
const REDACT_PATHS = [
  "token",
  "apiKey",
  "password",
  "keychainPassword",
  "secret",
  "authorization",
  "cookie",
].flatMap((key) => [key, `*.${key}`]);

export interface CreateLoggerOptions {
  readonly dir: string;
  /** The file prefix and the `name` field: `server` or `desktop`. */
  readonly name: string;
  readonly level?: LogLevel;
  /** Also writes each line to stdout, for development. */
  readonly echo?: boolean;
  readonly now?: () => Date;
}

/** A pino logger writing redacted JSON lines to `<dir>/<name>-<yyyy-mm-dd>.log`. */
export function createLogger(options: CreateLoggerOptions): {
  readonly logger: Logger;
  readonly file: DailyFile;
} {
  const file = dailyFile({
    dir: options.dir,
    name: options.name,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.echo === true ? { echo: (line: string) => void process.stdout.write(line) } : {}),
  });
  const logger = pino(
    {
      level: options.level ?? "info",
      base: { name: options.name, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: CENSOR },
    },
    file,
  );
  return { logger, file };
}

/** The folder both the server and the desktop shell log to. */
export const logDirFor = (dataDir: string): string => join(dataDir, "logs");
