import type { HostedThreadWaited, HostedWorkspace } from "@gram/contracts";
import type { DeviceLogEntry } from "./log.ts";

/** What the personal device shows and answers: its state, and the results of its calls. */

export type LendingState = "off" | "on" | "resume";

export interface HostedWorkspaceState {
  readonly id: string;
  /** The server's words. */
  readonly name: string;
  readonly organisation: string;
  /** What the organisation allows a lent machine to do here. */
  readonly policy: HostedWorkspace["devices"];
  readonly lending: LendingState;
  readonly readOnly: boolean;
  readonly folders: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly path: string;
  }>;
  readonly connected: boolean;
}

export interface HostedServerState {
  readonly origin: string;
  /** What the server calls itself: its word. */
  readonly name: string;
  readonly signedIn: boolean;
  readonly paused: boolean;
  /** It takes threads moved from this machine. */
  readonly takesThreads: boolean;
  /** It gives threads that moved there back to this machine. */
  readonly givesThreads: boolean;
  /** It runs work sent from this machine, and lets it be followed, answered and stopped. */
  readonly runsWork: boolean;
  readonly workspaces: ReadonlyArray<HostedWorkspaceState>;
  /** The last call that failed, in words. */
  readonly problem?: string;
}

/** Why lending can't be offered here; signing in may still work. */
export type LendingUnavailable = "no-keyring" | "no-lock-signal" | "settings-edited";

export interface HostedDeviceState {
  readonly unavailable?: LendingUnavailable;
  readonly servers: ReadonlyArray<HostedServerState>;
}

export type Done = { readonly ok: true } | { readonly ok: false; readonly why: string };

export type ThreadMoved =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly notes: readonly string[];
      readonly url?: string;
    }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

export type ThreadFetched =
  | { readonly ok: true; readonly bundle: unknown }
  | { readonly ok: false; readonly why: string };

export type ThreadSettled =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

/** Work to run there, as a new thread of a workspace. `clientKey` makes a second send the same. */
export interface WorkToSend {
  readonly repositories: readonly string[];
  readonly text: string;
  readonly title?: string;
  readonly branch?: string;
  readonly clientKey: string;
}

export type WorkSent =
  | { readonly ok: true; readonly threadId: string; readonly branch?: string }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

/** What to wait for on a thread sent from here. */
export interface WorkWait {
  readonly after?: string;
  readonly until?: "reply" | "idle" | "waiting" | "message";
  readonly timeoutSeconds?: number;
}

export type WorkWaited =
  | { readonly ok: true; readonly waited: HostedThreadWaited }
  | { readonly ok: false; readonly why: string };

export type WorkMessaged =
  | { readonly ok: true; readonly queued: boolean; readonly after?: string }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

export interface LendChoice {
  readonly folders: ReadonlyArray<{
    readonly path: string;
    readonly label: string;
    /** The folder as it was when shown: a different one at the same path since isn't it. */
    readonly seen?: { readonly device: number; readonly inode: number };
  }>;
  readonly readOnly: boolean;
}

export interface ResumeShown {
  readonly folders: ReadonlyArray<string>;
  readonly readOnly: boolean;
}

/** The local log as the activity list shows it: the newest lines that check out. */
export interface DeviceActivity {
  readonly kept: boolean;
  readonly intact: boolean;
  readonly setAside: boolean;
  /** Newest first. */
  readonly entries: ReadonlyArray<DeviceLogEntry>;
  readonly more: boolean;
}
