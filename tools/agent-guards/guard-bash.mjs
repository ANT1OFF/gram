#!/usr/bin/env node
// Claude Code PreToolUse hook for Bash (.claude/settings.json): refuses the commands AGENTS.md
// rules out, and says what to do instead. It reads the hook's JSON on stdin and exits 2 with the
// reason on stderr to block; anything it cannot read is let through, since it is a guard against
// slips, not a sandbox.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STOP_BY_PATTERN =
  "Never stop processes by pattern (`pkill -f`, `killall`, or `kill` on `pgrep` matches): other " +
  "checkouts may share the machine. Stop your own check with `bun run check:cancel`, Ctrl-C a " +
  "command you started, or kill only the exact PIDs your command started (`kill <pid>`).";

const PUSH_TO_MAIN =
  "Never push to main or master, force pushes included. Push your feature branch " +
  "(`git push -u origin <branch>`) and open a pull request against main.";

/** `kill $(pgrep …)`, `kill \`pgrep …\`` and `pgrep … | xargs kill`. */
const KILL_PGREP = [
  /\bkill\b[^;&|\n]*(\$\(|`)\s*pgrep\b/,
  /\bpgrep\b[^;&\n]*\|\s*xargs\b[^;&|\n]*\bkill\b/,
];

const PROTECTED = new Set(["main", "master"]);

/** Splits a command line into words per simple command, honouring quotes; `$(…)` is its own command. */
export function commands(line) {
  const out = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === "$" && line[i + 1] === "(") {
      endCommand();
      i++;
    } else if (/[;&|\n()`]/.test(c)) endCommand();
    else if (/\s/.test(c)) endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

/** The program a simple command runs, past `sudo`, `env`, `command`, `exec` and assignments. */
function program(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) ||
      ["sudo", "env", "command", "exec", "nohup"].includes(w)
    )
      i++;
    else break;
  }
  const name = words[i]?.split("/").pop();
  return { name, args: words.slice(i + 1) };
}

/** The ref a refspec writes on the remote, without `+` and `refs/heads/`. */
function destination(refspec, currentBranch) {
  const spec = refspec.replace(/^\+/, "");
  const target = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
  const ref = target === "HEAD" || target === "@" ? (currentBranch ?? target) : target;
  return ref.replace(/^refs\/heads\//, "");
}

const PUSH_OPTIONS_WITH_VALUE = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
]);

/** Whether `git … push …` would update main or master on the remote. */
function pushesProtected(args, currentBranch) {
  let i = 0;
  // `git -C dir`, `git -c key=value` and other global options before the subcommand.
  while (i < args.length && args[i] !== "push") {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i])) i += 2;
    else if (args[i].startsWith("-")) i++;
    else return false;
  }
  if (args[i] !== "push") return false;
  const positional = [];
  let everything = false;
  for (i++; i < args.length; i++) {
    const a = args[i];
    if (PUSH_OPTIONS_WITH_VALUE.has(a)) i++;
    else if (a === "--all" || a === "--mirror" || a === "--branches") everything = true;
    else if (!a.startsWith("-") || a === "-") positional.push(a);
  }
  if (everything) return true;
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return currentBranch !== undefined && PROTECTED.has(currentBranch);
  return refspecs.some((spec) => PROTECTED.has(destination(spec, currentBranch)));
}

/**
 * Whether to refuse a Bash command, and why. `currentBranch` is the checkout's branch, for a
 * push that names no branch or pushes `HEAD`.
 */
export function decide(command, { currentBranch } = {}) {
  if (KILL_PGREP.some((pattern) => pattern.test(command)))
    return { block: true, reason: STOP_BY_PATTERN };
  for (const words of commands(command)) {
    const { name, args } = program(words);
    const script = ["sh", "bash", "zsh"].includes(name) ? args[args.indexOf("-c") + 1] : undefined;
    if (args.includes("-c") && script !== undefined) {
      const inner = decide(script, { currentBranch });
      if (inner.block) return inner;
    }
    if (name === "pkill" || name === "killall") return { block: true, reason: STOP_BY_PATTERN };
    if (name === "git" && pushesProtected(args, currentBranch))
      return { block: true, reason: PUSH_TO_MAIN };
  }
  return { block: false };
}

function branchAt(cwd) {
  try {
    return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string") process.exit(0);
  const verdict = decide(command, {
    currentBranch: /\bgit\b[\s\S]*\bpush\b/.test(command) ? branchAt(input.cwd) : undefined,
  });
  if (verdict.block) {
    process.stderr.write(`Blocked by .claude/settings.json: ${verdict.reason}\n`);
    process.exit(2);
  }
}
