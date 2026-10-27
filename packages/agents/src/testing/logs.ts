import * as Cause from "effect/Cause";
import type * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as References from "effect/References";

/** One Effect log entry a test's logger kept. */
export interface CapturedLog {
  readonly level: LogLevel.LogLevel;
  /** The entry's message parts, joined with spaces. */
  readonly message: string;
  /** The `Effect.annotateLogs` fields it carried. */
  readonly annotations: Readonly<Record<string, unknown>>;
  /** The cause it was logged with, pretty-printed, or `undefined` for none. */
  readonly cause: string | undefined;
}

export interface CapturedLogs {
  /** Every entry so far, oldest first. */
  readonly logs: ReadonlyArray<CapturedLog>;
  /** The entries at `Warn` and above. */
  readonly warnings: () => ReadonlyArray<CapturedLog>;
  /** Replaces Effect's default console logger with the capturing one. */
  readonly layer: Layer.Layer<never>;
}

const partText = (part: unknown): string => {
  if (typeof part === "string") return part;
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
};

const isWarning = (level: LogLevel.LogLevel) => LogLevel.isGreaterThanOrEqualTo(level, "Warn");

/**
 * A test's logger. Test layers that don't install the server's pino logger leave Effect's default
 * one in place, which prints every entry to the console; this keeps them in `logs` instead, for the
 * test to assert on.
 *
 * With `printWarnings`, entries at `Warn` and above still print through the default logger: for a
 * test whose info lines are routine but where a warning would be news.
 */
export const captureLogs = (options?: { readonly printWarnings?: boolean }): CapturedLogs => {
  const logs: Array<CapturedLog> = [];
  const logger = Logger.make<unknown, void>((entry) => {
    const { logLevel, message, cause, fiber } = entry;
    logs.push({
      level: logLevel,
      message: (Array.isArray(message) ? message : [message]).map(partText).join(" "),
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      cause:
        Cause.hasFails(cause) || Cause.hasDies(cause) || Cause.hasInterrupts(cause)
          ? Cause.pretty(cause)
          : undefined,
    });
    if (options?.printWarnings === true && isWarning(logLevel)) Logger.defaultLogger.log(entry);
  });
  return {
    logs,
    warnings: () => logs.filter((log) => isWarning(log.level)),
    layer: Logger.layer([logger]),
  };
};
