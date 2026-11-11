import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { displayCommand } from "@gram/contracts";
import type { HostedDevice } from "@gram/shell/modules/device";

/**
 * This machine as a personal device of a hosted control plane, in the main process: made while
 * the hosted features setting (`experimental.embedding`) is on, which the server tells main as
 * `{ type: "embedding", on }`, and closed when it goes off or the app quits. Nothing is made, read
 * or kept while it is off. The design is `docs/design/personal-device.md`.
 */

/** Whether the hosted features are on, from the server's `{ type: "embedding", on }` message. */
export const embeddingFromMessage = (message: unknown): boolean | null => {
  if (typeof message !== "object" || message === null) return null;
  const { type, on } = message as { type?: unknown; on?: unknown };
  return type === "embedding" && typeof on === "boolean" ? on : null;
};

/** What a made device holds beside itself, to end with it. */
export interface MadeDevice {
  readonly device: HostedDevice;
  /** Ends what was made with it: presence, the asks. */
  readonly end: () => void;
}

export interface DeviceHostOptions {
  /** Makes the device; called once the app is ready, and only while the setting is on. */
  readonly make: () => Promise<MadeDevice>;
  readonly ready: () => Promise<void>;
  readonly failed: (error: unknown) => void;
  /** The device came or went, for the windows that show it. */
  readonly changed?: () => void;
}

export interface DeviceHost {
  /** The server said the setting is on, or off. */
  readonly setEmbedding: (on: boolean) => void;
  /** The device while the setting is on and it was made. */
  readonly device: () => HostedDevice | undefined;
  /**
   * Ends the device until the server says the setting is on again, as an update does: its
   * restarted server says so, and one that didn't restart leaves it off.
   */
  readonly stop: () => Promise<void>;
  /** Ends the device, as a quit does: nothing is made after. */
  readonly close: () => Promise<void>;
}

/**
 * Follows the setting: one device at a time, made after the last one closed, and none after a
 * quit. A setting turned off and on again while one is being made gets the newest answer.
 */
export const createDeviceHost = (options: DeviceHostOptions): DeviceHost => {
  let wanted = false;
  let closed = false;
  let made: MadeDevice | undefined;
  /** The make or end under way; the next waits for it. */
  let turning: Promise<void> = Promise.resolve();

  const end = async () => {
    const was = made;
    made = undefined;
    if (was === undefined) return;
    options.changed?.();
    try {
      await was.device.close();
    } finally {
      was.end();
    }
  };

  const follow = async () => {
    if (!wanted || closed) return end();
    if (made !== undefined) return;
    await options.ready();
    if (!wanted || closed) return;
    const next = await options.make();
    if (!wanted || closed) {
      await next.device.close().finally(next.end);
      return;
    }
    made = next;
    options.changed?.();
  };

  /** A turn queued and not yet begun: changes before it begins are its to follow. */
  let queued = false;
  const turn = () => {
    if (queued) return turning;
    queued = true;
    turning = turning
      .catch(() => undefined)
      .then(() => {
        queued = false;
        return follow();
      })
      .catch((error: unknown) => options.failed(error));
    return turning;
  };

  return {
    setEmbedding: (on) => {
      if (on === wanted) return;
      wanted = on;
      void turn();
    },
    device: () => made?.device,
    stop: async () => {
      wanted = false;
      await turn();
    },
    close: async () => {
      closed = true;
      await turn();
    },
  };
};

/** "this Mac" or "this computer", as the ask names the machine. */
export const machineWord = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "this Mac" : "this computer";

/** The machine's name as the server lists it. */
export const machineName = (): string => hostname().replace(/\.local$/, "") || "Computer";

/** Where the agents keep their logins when they are configured elsewhere than home. */
export const agentHomes = (env: Readonly<Record<string, string | undefined>>): Array<string> =>
  ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && isAbsolute(value));

/** The device's files, in the app's own data folder, which no lent folder may contain. */
export const deviceDataDir = (dataDir: string): string => join(dataDir, "device");

/** The ask's colours: the windows' own background and text, and the palette's others. */
export const askColorsFor = (
  window: { readonly background: string; readonly foreground: string },
  dark: boolean,
) => ({
  background: window.background,
  foreground: window.foreground,
  muted: dark ? "#bfbfbf" : "#525259",
  border: dark ? "#2d2d2d" : "#cdcdce",
  accent: dark ? "#346bf1" : "#1b4ed8",
  warning: dark ? "#ffb900" : "#ba7a00",
});

/**
 * A server's own words on one line, as a main-owned dialog shows them: codes nobody could see
 * (bidirectional, zero-width, control) drawn as their codes, and line breaks as spaces, so the
 * words can't reorder or add to the dialog's own. Whether they had such codes, or letters outside
 * ASCII that may be look-alikes, is said beside them.
 */
export const serverWords = (text: string): { readonly text: string; readonly unusual: boolean } => {
  const display = displayCommand(text);
  return {
    text: display.pieces
      .map((piece) => (piece.kind === "newline" ? " " : piece.text))
      .join("")
      .trim(),
    unusual: display.hidden || display.nonAscii,
  };
};

/** The dialog that asks the person to accept a server they haven't signed in to before. */
export const confirmServerDialog = (server: { readonly origin: string; readonly name: string }) => {
  const name = serverWords(server.name);
  return {
    type: "question" as const,
    title: "Sign in to a server",
    message: `Sign in to ${server.origin}?`,
    detail: [
      "Once you lend it this computer, it can ask to run commands and read files in the " +
        "folders you lend. You approve each.",
      "",
      `The server names itself: ${name.text}`,
      ...(name.unusual
        ? ["Its name has characters you can't see, or letters that may look like others."]
        : []),
    ].join("\n"),
    buttons: ["Sign in", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
};
