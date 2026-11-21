const SHELL_TOOL = /bash|shell|exec|command|terminal/i;

const REMOTE_COMMAND =
  /\bgit\s+(?:-\S+(?:\s+[^\s-]\S*)?\s+)*push\b|\bgh\s+pr\s+(?:create|merge|ready|close|reopen|comment|review|edit|update-branch)\b|\bgh\s+(?:run\s+rerun|workflow\s+run)\b/;

const MAX_SCAN = 8_192;

const strings = (value: unknown, depth = 0): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (depth >= 3 || typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((each) => strings(each, depth + 1));
};

/** Whether the tool call runs a command that changes what GitHub would say about the thread's PR. */
export const touchesRemote = (toolName: string, input: unknown): boolean =>
  SHELL_TOOL.test(toolName) && REMOTE_COMMAND.test(strings(input).join(" ").slice(0, MAX_SCAN));
