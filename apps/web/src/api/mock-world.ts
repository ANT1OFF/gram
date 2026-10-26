import type {
  GitState,
  McpTarget,
  Project,
  RuntimeSourceChoice,
  Settings,
  GramUIMessage,
  Thread,
  ThreadId,
  ThreadSummary,
  UserInput,
  WaitItem,
} from "@gram/contracts";

import type { ApiServerEvent } from "./types";

/** A data part of a transcript message. */
export type DataPart = Extract<GramUIMessage["parts"][number], { type: `data-${string}` }>;

/** What the mock's domain slices share with its core: its threads and its pace. */
export interface MockWorld {
  /** Resolves after `ms`, scaled by the mock's speed. */
  delay(ms: number): Promise<void>;
  /** The thread's summary as the sidebar has it; throws `ThreadNotFound` for an unknown thread. */
  summary(threadId: ThreadId): ThreadSummary;
  /** Every open thread's summary. */
  threads(): readonly ThreadSummary[];
  /** The thread's messages as its feed has folded them so far. */
  messages(threadId: ThreadId): readonly GramUIMessage[];
  /** Resolves once the thread's feed has folded every chunk sent so far. */
  settled(threadId: ThreadId): Promise<void>;
  /** Whether a turn of the thread is under way. */
  running(threadId: ThreadId): boolean;
  /** Sends `input` to the thread, as `Api.send` does. */
  send(threadId: ThreadId, input: UserInput): Promise<unknown>;
  /** Steers the thread's running turn with `input`, as `Api.steer` does. */
  steer(threadId: ThreadId, input: UserInput): Promise<void>;
  /** The projects as `listProjects` has them. */
  projects(): readonly Project[];
  /** Replaces the projects with what `update` makes of them. */
  updateProjects(update: (projects: readonly Project[]) => Project[]): void;
  /** A fresh id, unique for the mock's lifetime. */
  ids(): string;
  /** Waits at the scripted gate `name` until a spec calls `release(name)`; a release before is kept. */
  gate(name: string): Promise<void>;
  /** Stores the thread and emits `thread.upsert`, as the server's store does. */
  replaceThread(thread: Thread): void;
  /** Sets the thread's git state and emits `git.state`, as the server's publisher does. */
  publishGit(threadId: ThreadId, state: GitState): void;
  /** Sets the thread's lapsed connectors and emits `thread.lapsedConnectors`, as the server does. */
  publishLapsedConnectors(threadId: ThreadId, names: readonly string[]): void;
  /** Patches the thread and emits `thread.upsert`. */
  updateThread(threadId: ThreadId, patch: Partial<Thread>): void;
  /** The settings as the mock's `getSettings` has them. */
  settings(): Promise<Settings>;
  /** Keeps which Codex install new sessions start from in Settings, as the server does. */
  setCodexRuntime(source: RuntimeSourceChoice): Promise<void>;
  /**
   * Sets the thread's open Waiting on you items, and what the helper resolved lately, and emits
   * `thread.waits`, as the server does.
   */
  setWaits(
    threadId: ThreadId,
    waits: readonly WaitItem[],
    helperResolved?: readonly WaitItem[],
  ): void;
  /**
   * Puts a data part in the transcript as an app tool's would land: replacing the one with its type
   * and id in `messageId`, or else appended to the thread's last assistant message, or a message of
   * its own when there is none. Answers the message it is in.
   */
  putDataPart(threadId: ThreadId, part: DataPart, messageId?: string): string;
  /** Pushes `event` to every `events` subscriber, as the server's event hub does. */
  emit(event: ApiServerEvent): void;
  /**
   * An agent's MCP config changed, for every folder or only `folder`'s: its live threads restart
   * once idle, as the server's `mcpConfigChanged` has them.
   */
  mcpConfigChanged(agent: McpTarget, folder: string | undefined): Promise<void>;
}
