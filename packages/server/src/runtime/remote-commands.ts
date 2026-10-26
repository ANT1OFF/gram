// Spotting, in an agent's tool calls, the commands GitHub reacts to. A push starts CI and a review
// round; `gh pr create` makes the PR the badge is waiting for. Seen here, the thread's GitHub state is
// refreshed as the command finishes, and a turn that ran none of them needn't ask GitHub anything
// when it ends — which every turn used to, whatever it did.
//
// Deliberately loose: a false positive costs one lookup, and a command this misses (a push inside a
// script) is picked up by the next sweep, seconds later for a thread that was just working.

/** Tools that run a command line, across the agents' names for them. */
const SHELL_TOOL = /bash|shell|exec|command|terminal/i;

const REMOTE_COMMAND =
  /\bgit\s+(?:-\S+(?:\s+[^\s-]\S*)?\s+)*push\b|\bgh\s+pr\s+(?:create|merge|ready|close|reopen|comment|review|edit|update-branch)\b|\bgh\s+(?:run\s+rerun|workflow\s+run)\b/;

/** Longest command text worth scanning; a heredoc of a megabyte isn't a push. */
const MAX_SCAN = 8_192;

/** Every string in `value`, a few levels down: agents pass the command as a field, or as argv. */
const strings = (value: unknown, depth = 0): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (depth >= 3 || typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((each) => strings(each, depth + 1));
};

/** Whether the tool call runs a command that changes what GitHub would say about the thread's PR. */
export const touchesRemote = (toolName: string, input: unknown): boolean =>
  SHELL_TOOL.test(toolName) && REMOTE_COMMAND.test(strings(input).join(" ").slice(0, MAX_SCAN));
