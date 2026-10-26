import * as Schema from "effect/Schema";
import { TerminalId, ThreadId } from "./ids.ts";

/** TCP ports listening inside a thread's agent and terminal process trees, ascending. */
export const ListeningPorts = Schema.Array(Schema.Int);
export type ListeningPorts = typeof ListeningPorts.Type;

/** Pushed when a thread's listening ports change; an empty list clears its chips. */
export const ThreadPortsEvent = Schema.Struct({
  type: Schema.Literal("thread.ports"),
  threadId: ThreadId,
  ports: ListeningPorts,
});
export type ThreadPortsEvent = typeof ThreadPortsEvent.Type;

/**
 * A process running in one of a thread's terminals besides its shell: the foreground job on macOS
 * and Linux, and on Windows, which has no job control, a process the shell started that is still
 * running, in the foreground or not.
 */
export const TerminalProcess = Schema.Struct({
  terminalId: TerminalId,
  pid: Schema.Int,
  /** Its command line, shortened: `pnpm dev` rather than `node /opt/homebrew/bin/pnpm dev`. */
  command: Schema.String,
  /** Epoch ms the scan first saw it, to within the scan's interval. */
  startedAt: Schema.Int,
});
export type TerminalProcess = typeof TerminalProcess.Type;

/** Pushed when what runs in a thread's terminals changes; an empty list says none is busy. */
export const ThreadTerminalProcessesEvent = Schema.Struct({
  type: Schema.Literal("thread.terminalProcesses"),
  threadId: ThreadId,
  processes: Schema.Array(TerminalProcess),
});
export type ThreadTerminalProcessesEvent = typeof ThreadTerminalProcessesEvent.Type;

/** `app.openExternal`: opens `url` in the default browser of the machine running the server. */
export const OpenExternalPayload = { url: Schema.String };

/** Only http(s) URLs may be opened externally. */
export const isExternalUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** What a port chip opens. */
export const localPortUrl = (port: number): string => `http://localhost:${port}`;
