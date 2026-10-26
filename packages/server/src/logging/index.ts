/** Logging shared with the desktop shell, which bundles this entry point: plain Node, no Effect. */
export { defaultDataDir } from "./data-dir.ts";
export { latestLogFile, localDay, logFileName, tailLines } from "./daily-file.ts";
export { createLogger, logDirFor, type CreateLoggerOptions } from "./logger.ts";
export { redactSecrets, redactText } from "./redact.ts";
