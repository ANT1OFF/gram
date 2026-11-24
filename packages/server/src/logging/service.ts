import type { LogLevel } from "@gram/contracts";
import type { LogLevel as EffectLogLevel } from "effect/LogLevel";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import pino, { type Logger as PinoLogger } from "pino";
import { redactSecrets } from "./redact.ts";
import * as Predicate from "effect/Predicate";

export interface ServerLogShape {
  readonly logger: PinoLogger;
  /** The folder holding the log files; absent when nothing is written to disk. */
  readonly logDir: string | undefined;
  /** Applies the `logLevel` setting. */
  readonly setLevel: (level: LogLevel) => Effect.Effect<void>;
}

/** The server's logger. Defaults to a disabled one, so test layers needn't provide it. */
export const ServerLog = Context.Reference<ServerLogShape>("@gram/server/ServerLog", {
  defaultValue: () => {
    const logger = pino({ enabled: false });
    return {
      logger,
      logDir: undefined,
      setLevel: (level) =>
        Effect.sync(() => {
          logger.level = level;
        }),
    };
  },
});

const PINO_LEVELS: Partial<
  Record<EffectLogLevel, "fatal" | "error" | "warn" | "info" | "debug" | "trace">
> = {
  Fatal: "fatal",
  Error: "error",
  Warn: "warn",
  Info: "info",
  Debug: "debug",
  Trace: "trace",
};

const partText = (part: unknown): string => {
  if (typeof part === "string") return part;
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
};

const redactedAnnotations = (annotations: unknown): Record<string, unknown> =>
  Predicate.isObject(annotations) ? annotations : {};

const pinoLogger = (logger: PinoLogger): Logger.Logger<unknown, void> =>
  Logger.make(({ logLevel, message, cause, fiber }) => {
    const level = PINO_LEVELS[logLevel];
    if (level === undefined || !logger.isLevelEnabled(level)) return;
    const msg = (Array.isArray(message) ? message : [message]).map(partText).join(" ");
    const fields = {
      ...redactedAnnotations(redactSecrets(fiber.getRef(References.CurrentLogAnnotations))),
      ...(Cause.hasFails(cause) || Cause.hasDies(cause) || Cause.hasInterrupts(cause)
        ? { cause: Cause.pretty(cause) }
        : {}),
    };
    if (Object.keys(fields).length > 0) logger[level](fields, msg);
    else logger[level](msg);
  });

/** Provides `ServerLog` and sends every Effect log entry, at any level, to its pino logger. */
export const serverLogLayer = (log: ServerLogShape): Layer.Layer<never> =>
  Layer.mergeAll(
    Layer.succeed(ServerLog, log),
    Logger.layer([pinoLogger(log.logger)]),
    Layer.succeed(References.MinimumLogLevel, "All"),
  );
