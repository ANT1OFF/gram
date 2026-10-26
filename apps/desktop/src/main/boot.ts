import type { LogLevel } from "@gram/contracts";

const BOOT_PREFIX = "boot ";
const LOG_LEVELS: ReadonlySet<string> = new Set(["error", "warn", "info", "debug", "trace"]);

/** The level from the server's `{ type: "logLevel", level }` message, posted when the setting changes. */
export function logLevelFromMessage(message: unknown): LogLevel | null {
  if (typeof message !== "object" || message === null) return null;
  const { type, level } = message as Record<string, unknown>;
  return type === "logLevel" && typeof level === "string" && LOG_LEVELS.has(level)
    ? (level as LogLevel)
    : null;
}

/** A loopback http URL carrying a non-empty launch token (`/?boot=<token>`), else null. */
function launchUrl(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  try {
    const url = new URL(candidate);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return url.protocol === "http:" && loopback && url.searchParams.get("boot") ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * The boot URL from the server's `{ type: "boot", url }` message, which it posts over
 * `process.parentPort` under utilityProcess. Null for any other message.
 */
export function bootUrlFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const { type, url } = message as Record<string, unknown>;
  return type === "boot" ? launchUrl(url) : null;
}

/** Whether a stdout line is the server's boot line, which is never logged. */
export function isBootLine(line: string): boolean {
  return line.startsWith(BOOT_PREFIX);
}

/**
 * The boot URL from a `boot <url>` stdout line, for the headless / dev fallback. Null when the line
 * carries no launch token, as it doesn't under utilityProcess.
 */
export function bootUrlFromLine(line: string): string | null {
  return isBootLine(line) ? launchUrl(line.slice(BOOT_PREFIX.length).trim()) : null;
}

/**
 * The boot URL moved onto the Vite dev origin, whose proxy forwards `/?boot` to the server, so the
 * auth cookie is set for the origin the renderer runs on.
 */
export function devBootUrl(bootUrl: string, webUrl: string): string {
  const url = new URL("/", webUrl);
  url.searchParams.set("boot", new URL(bootUrl).searchParams.get("boot") ?? "");
  return url.href;
}

/** `GRAM_ALLOWED_ORIGINS` for dev: the Vite origin, under both loopback host names. */
export function devAllowedOrigins(webUrl: string): string {
  const { origin, port, protocol } = new URL(webUrl);
  return [...new Set([origin, `${protocol}//127.0.0.1:${port}`])].join(",");
}
