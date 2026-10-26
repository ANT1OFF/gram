import * as Schema from "effect/Schema";
import { CodexHome } from "./codex-home.ts";
import { ThreadId } from "./ids.ts";

// Resume from history, keybindings.json and Open in editor.

/** A past agent conversation for a folder, resumable into a new thread. */
export const AgentSessionSummary = Schema.Struct({
  agentSessionId: Schema.String,
  /** The user's custom title, else the agent's summary, else the first prompt. */
  title: Schema.String,
  firstPrompt: Schema.optionalKey(Schema.String),
  /** Epoch ms of the last change. */
  updatedAt: Schema.Number,
  gitBranch: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  /** Codex: the home the session lives in; pass it to `thread.create` with `resumeSessionId`. */
  codexHome: Schema.optionalKey(CodexHome),
  /** The thread already showing this session. */
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentSessionSummary = typeof AgentSessionSummary.Type;

export const AgentSessionList = Schema.Struct({
  /** False when the agent can't list its sessions; `sessions` is then empty. */
  supported: Schema.Boolean,
  sessions: Schema.Array(AgentSessionSummary),
});
export type AgentSessionList = typeof AgentSessionList.Type;

/** Shortcut id → keys (`mod+shift+k`; `mod` is ⌘ on macOS, Ctrl elsewhere), or null to disable it. */
export const KeybindingOverrides = Schema.Record(Schema.String, Schema.NullOr(Schema.String));
export type KeybindingOverrides = typeof KeybindingOverrides.Type;

export const KeybindingsState = Schema.Struct({
  /** Where `keybindings.json` lives. */
  path: Schema.String,
  bindings: KeybindingOverrides,
  /** Why parts of the file were ignored. */
  problems: Schema.Array(Schema.String),
});
export type KeybindingsState = typeof KeybindingsState.Type;

export const EditorOpened = Schema.Struct({
  /** The editor launched, e.g. "VS Code". */
  editor: Schema.String,
});
export type EditorOpened = typeof EditorOpened.Type;

export const Revealed = Schema.Struct({
  /** The file manager shown, e.g. "Finder". */
  manager: Schema.String,
});
export type Revealed = typeof Revealed.Type;
