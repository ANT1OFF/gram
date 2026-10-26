import type { AgentEvent } from "@gram/contracts";
import { relativeInside } from "@gram/git";

const MAX_TEXT = 60;

const truncate = (text: string, max = MAX_TEXT): string => {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/**
 * `path` relative to `cwd` when it's inside it, shortened from the left when long. Separators are
 * `/` on every OS, so the line reads the same everywhere.
 */
const displayPath = (path: string, cwd: string | undefined): string => {
  const inside = cwd === undefined ? undefined : relativeInside(cwd, path);
  const shown = (inside !== undefined && inside !== "" ? inside : path).replaceAll("\\", "/");
  return shown.length <= MAX_TEXT ? shown : `…${shown.slice(-(MAX_TEXT - 1))}`;
};

const field = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

const subagentLabel = (input: unknown) => field(input, "subagent_type") ?? "Agent";

const activeTodo = (input: unknown): string | undefined => {
  const todos =
    typeof input === "object" && input !== null ? (input as { todos?: unknown }).todos : undefined;
  if (!Array.isArray(todos)) return undefined;
  const active: unknown = todos.find((todo) => field(todo, "status") === "in_progress");
  return field(active, "activeForm") ?? field(active, "content");
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return truncate(url);
  }
};

/** One line for a tool call; `edited` collects the files edited this turn. */
const describeTool = (
  name: string,
  input: unknown,
  cwd: string | undefined,
  edited: Set<string>,
): string => {
  switch (name) {
    case "Bash": {
      const command = field(input, "command");
      return command === undefined ? "Running a command" : `Running ${truncate(command)}`;
    }
    case "Read":
    case "NotebookRead": {
      const file = field(input, "file_path") ?? field(input, "notebook_path");
      return file === undefined ? "Reading a file" : `Reading ${displayPath(file, cwd)}`;
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const file = field(input, "file_path") ?? field(input, "notebook_path");
      if (file === undefined)
        return edited.size > 1 ? `Editing ${edited.size} files` : "Editing a file";
      edited.add(file);
      if (edited.size > 1) return `Editing ${edited.size} files`;
      return `${name === "Write" ? "Writing" : "Editing"} ${displayPath(file, cwd)}`;
    }
    case "Glob": {
      const pattern = field(input, "pattern");
      return pattern === undefined ? "Finding files" : `Finding ${truncate(pattern)}`;
    }
    case "Grep": {
      const pattern = field(input, "pattern");
      return pattern === undefined ? "Searching files" : `Searching for ${truncate(pattern)}`;
    }
    case "LS":
      return "Listing files";
    case "WebFetch": {
      const url = field(input, "url");
      return url === undefined ? "Fetching a page" : `Fetching ${hostOf(url)}`;
    }
    case "WebSearch": {
      const query = field(input, "query");
      return query === undefined ? "Searching the web" : `Searching the web for ${truncate(query)}`;
    }
    case "TodoWrite": {
      const todo = activeTodo(input);
      return todo === undefined ? "Updating the plan" : truncate(todo);
    }
    case "Task":
    case "Agent": {
      const description = field(input, "description");
      return description === undefined
        ? "Starting a subagent"
        : `${subagentLabel(input)}: ${truncate(description)}`;
    }
    case "ExitPlanMode":
      return "Presenting the plan";
    case "AskUserQuestion":
      return "Asking a question";
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp !== null) return `Using ${mcp[1]}: ${mcp[2]}`;
      return name === "" ? "Using a tool" : `Using ${name}`;
    }
  }
};

const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const KEEP = Symbol("keep");
/** The line while the agent compacts its context, which the web's live line says in full. */
const COMPACTING_LINE = "Compacting context";

/**
 * The short live "what is it doing" line for a thread ("Reading src/app.ts", "Waiting for
 * approval"), derived from agent events. It only reads our AI SDK chunks and control events, never
 * native payloads, so every adapter gets it.
 */
export class ActivityTracker {
  #line: string | undefined;
  /** The latest line derived from the agent's work, restored once a wait is over. */
  #work: string | undefined;
  #edited = new Set<string>();
  /** Subagent labels ("Explore"), by the tool call that started them. */
  #subagents = new Map<string, string>();
  /** The tool call that started each subagent message, by message id. */
  #subagentMessages = new Map<string, string>();
  /** Subagent messages still streaming; a background subagent streams on after the turn. */
  #openSubagents = new Set<string>();
  /** The latest line from a subagent, which stays up while one runs after the turn. */
  #subagentWork: string | undefined;
  #inTurn = false;

  get line(): string | undefined {
    return this.#line;
  }

  /** A subagent is still running, e.g. in the background after the turn that launched it. */
  get subagentsRunning(): boolean {
    return this.#openSubagents.size > 0;
  }

  /** Folds `event` in; `cwd` shortens file paths. Returns whether the line changed. */
  apply(event: AgentEvent, cwd?: string): boolean {
    const before = this.#line;
    const next = this.#next(event, cwd);
    if (next === KEEP) return false;
    this.#line = next;
    return next !== before;
  }

  /** Forgets everything: the line, edited files and subagents. */
  reset(): void {
    this.#line = undefined;
    this.#work = undefined;
    this.#subagentWork = undefined;
    this.#inTurn = false;
    this.#edited.clear();
    this.#subagents.clear();
    this.#subagentMessages.clear();
    this.#openSubagents.clear();
  }

  /** Forgets the turn's line and edits; a subagent still running keeps its label and line. */
  endTurn(): void {
    this.#line = this.#endTurn();
  }

  #endTurn(): string | undefined {
    if (this.#openSubagents.size === 0) {
      this.reset();
      return undefined;
    }
    this.#inTurn = false;
    this.#work = undefined;
    this.#edited.clear();
    return this.#subagentWork;
  }

  #next(event: AgentEvent, cwd: string | undefined): string | undefined | typeof KEEP {
    switch (event.type) {
      case "status":
        switch (event.status) {
          case "awaitingApproval":
            return "Waiting for approval";
          case "awaitingInput":
            return "Waiting for your answer";
          case "compacting":
            return COMPACTING_LINE;
          case "retrying":
            return event.detail ?? "Retrying";
          case "idle":
          case "error":
            return this.#endTurn();
          case "starting":
          case "running":
            this.#inTurn = true;
            // A `/compact` does no other work, and its line mustn't outlast it.
            return this.#work ?? (this.#line === COMPACTING_LINE ? undefined : KEEP);
        }
        return KEEP;
      case "request":
        switch (event.request.kind) {
          case "approval":
            return "Waiting for approval";
          case "question":
            return "Waiting for your answer";
          case "plan":
            return "Waiting for plan approval";
        }
        return KEEP;
      case "requestResolved":
        return this.#work;
      case "turnEnd":
        return this.#endTurn();
      case "ended":
        this.reset();
        return undefined;
      case "chunk":
        return this.#chunk(event.messageId, event.chunk, cwd);
      default:
        return KEEP;
    }
  }

  #chunk(
    messageId: string,
    chunk: unknown,
    cwd: string | undefined,
  ): string | undefined | typeof KEEP {
    const c = chunk as {
      readonly type: string;
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly input?: unknown;
      readonly messageMetadata?: { readonly parentToolUseId?: string };
    };
    switch (c.type) {
      case "start": {
        const parent = c.messageMetadata?.parentToolUseId;
        if (parent === undefined) {
          this.#inTurn = true;
        } else {
          this.#subagentMessages.set(messageId, parent);
          this.#openSubagents.add(messageId);
        }
        return KEEP;
      }
      case "finish":
      case "abort": {
        if (!this.#openSubagents.delete(messageId) || this.#openSubagents.size > 0) return KEEP;
        this.#subagentWork = undefined;
        // The last subagent is done; with no turn running there is nothing left to show.
        return this.#inTurn ? KEEP : undefined;
      }
      case "reasoning-start":
        return this.#working(messageId, "Thinking");
      case "text-start":
        return this.#working(messageId, "Writing a reply");
      case "tool-input-start": {
        const name = c.toolName ?? "";
        // Keep "Editing a.ts" while the next edit's input streams, rather than "Editing a file".
        if (EDIT_TOOLS.has(name) && this.#edited.size > 0) return KEEP;
        return this.#working(messageId, describeTool(name, undefined, cwd, this.#edited));
      }
      case "tool-input-available": {
        const name = c.toolName ?? "";
        if (SUBAGENT_TOOLS.has(name) && c.toolCallId !== undefined) {
          this.#subagents.set(c.toolCallId, subagentLabel(c.input));
        }
        return this.#working(messageId, describeTool(name, c.input, cwd, this.#edited));
      }
      default:
        return KEEP;
    }
  }

  /** Records `line` as the current work, prefixed with the subagent that's doing it. */
  #working(messageId: string, line: string): string {
    const parent = this.#subagentMessages.get(messageId);
    const label = parent === undefined ? undefined : this.#subagents.get(parent);
    const work = label === undefined ? line : `${label}: ${line}`;
    // The main agent working means a turn; a background subagent's work between turns isn't one.
    if (parent === undefined) this.#inTurn = true;
    if (this.#inTurn) this.#work = work;
    if (parent !== undefined) this.#subagentWork = work;
    return work;
  }
}
