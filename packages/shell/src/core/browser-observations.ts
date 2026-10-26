import type {
  BrowserDiagnostics,
  BrowserNetworkFailure,
  PaneConsoleEntry,
} from "@gram/contracts/link-trust";
import type { Cdp } from "./page-driver.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Only http(s) origins leave the driver. No raw path, query, fragment, userinfo or page errors. */
export function networkOrigin(raw: unknown): string {
  try {
    const url = new URL(String(raw));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "(URL omitted)";
  } catch {
    return "(URL omitted)";
  }
}

/** The dimensions encoded in the actual JPEG, independent of device scale or UI fit. */
export function jpegDimensions(data: string): { width: number; height: number } {
  const bytes = Buffer.from(data, "base64");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid page capture.");
  let offset = 2;
  while (offset + 8 < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (length < 2) break;
    offset += length + 2;
  }
  throw new Error("Page capture dimensions unavailable.");
}

/** Bounded observations only. Never retain headers, cookies, bodies or raw console arguments. */
export function browserObservations(cdp: Cdp, heldFrom: number | null) {
  const since = Date.now();
  let holding = heldFrom;
  let droppedConsole = 0;
  let droppedNetwork = 0;
  const console: PaneConsoleEntry[] = [];
  const network: BrowserNetworkFailure[] = [];
  const pending = new Map<
    string,
    { url: string; timestamp: number; at: number; status?: number }
  >();
  const log = (entry: PaneConsoleEntry) => {
    if (holding !== null) return;
    console.push(entry);
    if (console.length > 100) {
      console.shift();
      droppedConsole++;
    }
  };
  const failure = (entry: BrowserNetworkFailure) => {
    if (holding !== null) return;
    network.push(entry);
    if (network.length > 50) {
      network.shift();
      droppedNetwork++;
    }
  };
  const finish = (params: unknown, kind: "finished" | "failed") => {
    const event = record(params);
    const id = String(event["requestId"]);
    const request = pending.get(id);
    pending.delete(id);
    if (request === undefined || (kind === "finished" && (request.status ?? 0) < 400)) return;
    const end = event["timestamp"];
    const durationMs =
      typeof end === "number" && end >= request.timestamp
        ? Math.round((end - request.timestamp) * 1000)
        : undefined;
    failure({
      url: request.url,
      at: Date.now(),
      kind: kind === "failed" ? "transport" : "http",
      ...(request.status === undefined ? {} : { status: request.status }),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  };
  const off = [
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const event = record(params);
      const type = event["type"];
      const level =
        type === "error" || type === "assert"
          ? "error"
          : type === "warning"
            ? "warning"
            : type === "info"
              ? "info"
              : type === "debug" || type === "trace"
                ? "debug"
                : "log";
      log({
        level,
        text: `${Array.isArray(event["args"]) ? event["args"].length : 0} console argument(s); contents omitted.`,
        at: Date.now(),
      });
    }),
    cdp.on("Runtime.exceptionThrown", () =>
      log({ level: "error", text: "Uncaught page exception; contents omitted.", at: Date.now() }),
    ),
    cdp.on("Network.requestWillBeSent", (params) => {
      if (holding !== null) return;
      const event = record(params);
      if (typeof event["timestamp"] !== "number" || typeof event["requestId"] !== "string") return;
      // A redirect's new hop replaces the old one; retain a failed redirect response first.
      const old = pending.get(event["requestId"]);
      const redirect = record(event["redirectResponse"]);
      if (
        old !== undefined &&
        typeof redirect["status"] === "number" &&
        redirect["status"] >= 400
      ) {
        failure({ url: old.url, kind: "http", status: redirect["status"], at: Date.now() });
      }
      pending.set(event["requestId"], {
        url: networkOrigin(record(event["request"])["url"]),
        timestamp: event["timestamp"],
        at: Date.now(),
      });
      if (pending.size > 200) {
        pending.delete(pending.keys().next().value!);
        droppedNetwork++;
      }
    }),
    cdp.on("Network.responseReceived", (params) => {
      const event = record(params);
      const request = pending.get(String(event["requestId"]));
      const status = record(event["response"])["status"];
      if (request !== undefined && typeof status === "number") request.status = status;
    }),
    cdp.on("Network.loadingFinished", (params) => finish(params, "finished")),
    cdp.on("Network.loadingFailed", (params) => finish(params, "failed")),
  ];
  return {
    console: (errors: boolean) => console.filter((line) => !errors || line.level === "error"),
    diagnostics: (): BrowserDiagnostics => ({
      since,
      observedAt: Date.now(),
      console: [...console],
      network: [...network],
      droppedConsole,
      droppedNetwork,
      contentPolicy: "console-content-and-url-paths-omitted",
    }),
    hold: (from: number | null) => {
      holding = from;
      if (from === null) return;
      const trim = <T extends { at: number }>(list: T[]) => {
        const kept = list.filter((item) => item.at < from);
        list.splice(0, list.length, ...kept);
      };
      trim(console);
      trim(network);
      pending.clear();
    },
    dispose: () => off.forEach((unsubscribe) => unsubscribe()),
  };
}
