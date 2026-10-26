import type { OutwardGate } from "../host.ts";

const promptRule = (pattern: string, justification: string): string =>
  `prefix_rule(pattern=${pattern}, decision="prompt", justification=${JSON.stringify(justification)})\n`;

/**
 * Codex exec-policy rules that make the ordinary ways to push or publish ask. They are the
 * backstop of the outward gate, not the gate: a prefix rule matches only the plain spelling, so
 * `git -C dir push`, an env prefix, `bash -c` and `$(…)` slip past it, which is why the adapter
 * reads every command itself. What they are for is an allow rule: "always allow" on a push writes
 * `prefix_rule(["git", "push", …], decision="allow")` beside them, which alone would run the push
 * unasked in every approval policy, and where both match Codex takes the stricter `prompt`.
 *
 * The push rules stay at `irreversible` too, where an ordinary push is meant to go unasked. A push
 * that rewrites the remote can't be told from one that doesn't by its first words (the option can
 * follow the refspec, or be the refspec: `+main`, `:old`), so without them such an allow rule would
 * run `git push origin +main` unasked. With them Codex asks about every push and the adapter, which
 * can read the whole command, answers the ordinary ones itself. Only `gh pr create` is left out at
 * that level: nothing about opening a PR is irreversible, so there is nothing to catch.
 */
export const outwardPromptRules = (level: OutwardGate): string =>
  "# Written by Gram while a thread that asks before a push opens, then removed.\n" +
  promptRule('["git", "push"]', "Gram asks before a push") +
  promptRule('["git", "subtree", "push"]', "Gram asks before a push") +
  promptRule(
    level === "all"
      ? '["gh", "pr", ["create", "new", "merge", "close"]]'
      : '["gh", "pr", ["merge", "close"]]',
    level === "all"
      ? "Gram asks before a PR is opened, merged or closed"
      : "Gram asks before a PR is merged or closed",
  ) +
  promptRule('["gh", "release", ["create", "new"]]', "Gram asks before a release is cut") +
  promptRule('["gh", "workflow", "run"]', "Gram asks before a workflow is run") +
  promptRule('["gh", "repo", "delete"]', "Gram asks before a repository is deleted");

/** The rules of a gate that asks before every outward command: `outwardPromptRules("all")`. */
export const OUTWARD_PROMPT_RULES = outwardPromptRules("all");
