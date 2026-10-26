import type {
  AgentRuntime,
  CliUpdateProblem,
  CliUpdateState,
  Installer,
  RuntimeAgent,
} from "@gram/contracts";
import { CliUpdateRefused } from "@gram/contracts";
import type { ProcError, ProcOutput } from "@gram/git";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { redactText } from "../logging/redact.ts";
import { REGISTRY_SIGN_IN_EXPIRED, refusedForAge, refusedSignIn } from "./npm-registry.ts";
import { appendTail } from "../bounded.ts";

/**
 * Updating the user's own agent CLI from Settings → Agents: the one place Gram runs a
 * package manager, or a CLI's own updater, against an install it doesn't own. It runs only an
 * install step the listing offers with `run`, as that argv, through `Proc`: the login-shell PATH,
 * so `npm` is the user's npm with its own registry, sign-in and `min-release-age`, and no flag of
 * Gram's. One update per agent at a time; the state lives in memory only, so a restart
 * leaves nothing stuck, and closing the server interrupts a run, which kills the child. The managed
 * store (`service.ts`) is separate: it installs verified copies Gram owns.
 *
 * The output is shown to the user, tail-capped and scrubbed, and never logged.
 */

const AGENTS: ReadonlyArray<RuntimeAgent> = ["claude", "codex"];

const NAMES: Readonly<Record<RuntimeAgent, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** How much of the output the row shows. */
export const OUTPUT_TAIL_CHARS = 6_000;

/** How much raw output is kept to tidy into that tail. */
const RAW_TAIL_CHARS = 4 * OUTPUT_TAIL_CHARS;

/** How often the running state is republished while output arrives. */
const FLUSH_MS = 150;

// CSI sequences (colours, cursor moves) and OSC ones (titles, hyperlinks).
// oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** `scheme://user:password@`, which an npm error can print with the registry URL. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/**
 * Raw output as the row shows it: escape sequences dropped, a spinner's carriage-return redraws
 * kept to their last frame, token-shaped text and URL credentials scrubbed, then the last
 * `OUTPUT_TAIL_CHARS`, from a line start.
 */
export const tidyOutput = (raw: string): string => {
  const lines = raw
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      const frames = line.replace(/\r+$/, "").split("\r");
      return frames[frames.length - 1]!;
    });
  const text = redactText(lines.join("\n")).replace(URL_CREDENTIALS, "$1[redacted]@");
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  const tail = text.slice(-OUTPUT_TAIL_CHARS);
  const start = tail.indexOf("\n");
  return start === -1 ? tail : tail.slice(start + 1);
};

const packageManagers: ReadonlySet<Installer> = new Set(["npm", "pnpm", "bun"]);

/**
 * Why a run that exited `status` failed, from what it printed: the registry's refusal and the
 * release-age hold in the words the rest of the Agents rows use, a global install needing admin
 * rights, and on Windows an executable a running session holds. Never sudo: stdin is closed, and
 * the user runs it in a terminal instead.
 */
export const updateFailure = (
  agent: RuntimeAgent,
  installer: Installer,
  command: string,
  status: number,
  output: string,
): { readonly problem: CliUpdateProblem; readonly message: string } => {
  const name = NAMES[agent];
  if (packageManagers.has(installer) && refusedSignIn(output))
    return { problem: "sign-in", message: `${REGISTRY_SIGN_IN_EXPIRED}, then try again.` };
  if (packageManagers.has(installer) && refusedForAge(output))
    return {
      problem: "release-age",
      message: `Your registry is still holding this ${name} release back for its release age. Try again later.`,
    };
  if (/\bEBUSY\b/.test(output))
    return {
      problem: "in-use",
      message: `A running ${name} holds the files it would replace. Stop its threads, then try again.`,
    };
  if (/\bE(ACCES|PERM)\b|permission denied/i.test(output))
    return {
      problem: "permission",
      message: `This needs admin rights to write where ${name} is installed, and Gram never asks for sudo. Run the command yourself in a terminal.`,
    };
  return {
    problem: "failed",
    message: `\`${command}\` stopped with exit code ${status}. Its output is below.`,
  };
};

/** What a run that couldn't start, or overran, means. */
const procFailure = (
  error: ProcError,
  argv: ReadonlyArray<string>,
  command: string,
): { readonly problem: CliUpdateProblem; readonly message: string } =>
  error._tag === "ProcSpawnError"
    ? { problem: "missing", message: `\`${argv[0]!}\` isn't on your login-shell PATH.` }
    : {
        problem: "timeout",
        message: `\`${command}\` took longer than 5 minutes and was stopped.`,
      };

const refuse = (
  agent: RuntimeAgent,
  reason: "busy" | "not-offered",
  message: string,
): Effect.Effect<never, CliUpdateRefused> =>
  Effect.fail(new CliUpdateRefused({ agent, reason, message }));

/**
 * What runs for a step: a CLI's own updater (`claude update`) as the executable
 * the row resolved, so it is the install the listing judged and sessions start, not a shell wrapper
 * earlier on PATH (cmux's `claude`) that the probe skips; a package manager by name, on the
 * login-shell PATH, as the user's own.
 */
export const updateArgv = (
  installer: Installer,
  run: ReadonlyArray<string>,
  runtime: AgentRuntime | undefined,
): ReadonlyArray<string> =>
  installer === "native" && runtime?.resolved?.source === "path"
    ? [runtime.resolved.path, ...run.slice(1)]
    : run;

export interface CliUpdatesDeps {
  /** The agent's row as the listing has it now; its steps decide what may run. */
  readonly runtime: (agent: RuntimeAgent) => Effect.Effect<AgentRuntime | undefined>;
  /** Runs `argv` in the user's home with the `slow` bound, handing output over as it arrives. */
  readonly run: (
    argv: ReadonlyArray<string>,
    onOutput: (text: string) => void,
  ) => Effect.Effect<ProcOutput, ProcError>;
  /** Probes the machine again and answers the agent's version now. */
  readonly reprobe: (agent: RuntimeAgent) => Effect.Effect<string | undefined>;
  /** The agent's threads with a live session. */
  readonly runningThreads: (agent: RuntimeAgent) => Effect.Effect<number>;
  /** The CLI changed on disk: new sessions start from it, and live ones keep theirs. */
  readonly updated: (agent: RuntimeAgent) => Effect.Effect<void>;
  readonly now: () => number;
}

/** The updater over `deps`, scoped: closing the scope interrupts any run. */
export const makeCliUpdates = (deps: CliUpdatesDeps) =>
  Effect.gen(function* () {
    const refs = new Map<RuntimeAgent, SubscriptionRef.SubscriptionRef<CliUpdateState>>();
    for (const agent of AGENTS)
      refs.set(agent, yield* SubscriptionRef.make<CliUpdateState>({ state: "idle" }));
    const refOf = (agent: RuntimeAgent) => refs.get(agent)!;
    const jobs = yield* FiberMap.make<RuntimeAgent>();
    /** Taken before anything yields, so a second request can't also pass the check. */
    const reserved = new Set<RuntimeAgent>();

    /** The run itself, from the confirmed step to its outcome. */
    const job = (
      agent: RuntimeAgent,
      step: { readonly installer: Installer; readonly command: string },
      argv: ReadonlyArray<string>,
      running: Extract<CliUpdateState, { state: "running" }>,
      from: string | undefined,
    ) =>
      Effect.gen(function* () {
        const ref = refOf(agent);
        const { command } = step;
        let raw = "";
        let dirty = false;
        const flush = Effect.suspend(() => {
          if (!dirty) return Effect.void;
          dirty = false;
          return SubscriptionRef.set(ref, { ...running, output: tidyOutput(raw) });
        });
        yield* Effect.forkScoped(
          Effect.forever(Effect.sleep(FLUSH_MS).pipe(Effect.andThen(flush)), {
            disableYield: true,
          }),
        );
        const result = yield* deps
          .run(argv, (text) => {
            raw = appendTail(raw, text, RAW_TAIL_CHARS);
            dirty = true;
          })
          .pipe(
            Effect.map((out) => ({ out, error: undefined })),
            Effect.catch((error: ProcError) => Effect.succeed({ out: undefined, error })),
          );
        const output = tidyOutput(raw);
        if (result.out === undefined || result.out.status !== 0) {
          const failure =
            result.out === undefined
              ? procFailure(result.error!, argv, command)
              : updateFailure(
                  agent,
                  step.installer,
                  command,
                  result.out.status,
                  `${result.out.stderr}\n${result.out.stdout}`,
                );
          yield* SubscriptionRef.set(ref, { state: "failed", command, output, ...failure });
          return;
        }
        // The CLI has changed by now, so a cancel arriving here waits for the probe to finish.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* deps.updated(agent);
            const version = yield* deps.reprobe(agent);
            const runningThreads = yield* deps.runningThreads(agent);
            yield* SubscriptionRef.set(ref, {
              state: "succeeded",
              command,
              output,
              ...(from === undefined ? {} : { from }),
              ...(version === undefined ? {} : { version }),
              runningThreads,
            });
          }),
        );
      }).pipe(
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const ref = refOf(agent);
            const now = yield* SubscriptionRef.get(ref);
            if (now.state !== "running") return;
            yield* SubscriptionRef.set(ref, {
              state: "failed",
              command: step.command,
              output: now.output,
              problem: "cancelled",
              message:
                "Cancelled. It may have stopped part-way; run it again, or run it yourself in a terminal.",
            });
          }),
        ),
        Effect.ensuring(Effect.sync(() => reserved.delete(agent))),
      );

    const begin = (agent: RuntimeAgent, command: string) =>
      Effect.gen(function* () {
        const runtime = yield* deps.runtime(agent);
        const step = runtime?.installSteps.find((s) => s.command === command);
        if (step?.run === undefined)
          return yield* refuse(
            agent,
            "not-offered",
            `Gram doesn't offer to run that for ${NAMES[agent]} now. Check again, or run it yourself.`,
          );
        const running: Extract<CliUpdateState, { state: "running" }> = {
          state: "running",
          command,
          output: "",
          startedAt: deps.now(),
          runningThreads: yield* deps.runningThreads(agent),
        };
        yield* SubscriptionRef.set(refOf(agent), running);
        yield* FiberMap.run(
          jobs,
          agent,
          job(
            agent,
            step,
            updateArgv(step.installer, step.run, runtime),
            running,
            runtime?.resolved?.version,
          ),
        );
        return running as CliUpdateState;
      });

    return {
      state: (agent: RuntimeAgent) => SubscriptionRef.get(refOf(agent)),
      watch: (agent: RuntimeAgent): Stream.Stream<CliUpdateState> =>
        SubscriptionRef.changes(refOf(agent)),
      start: (agent: RuntimeAgent, command: string) =>
        Effect.gen(function* () {
          if (reserved.has(agent))
            return yield* refuse(
              agent,
              "busy",
              `An update of ${NAMES[agent]} is already running. Wait for it, or cancel it.`,
            );
          reserved.add(agent);
          return yield* begin(agent, command).pipe(
            Effect.onError(() => Effect.sync(() => reserved.delete(agent))),
          );
        }),
      cancel: (agent: RuntimeAgent) =>
        Effect.gen(function* () {
          const ref = refOf(agent);
          if ((yield* SubscriptionRef.get(ref)).state === "running") {
            yield* FiberMap.remove(jobs, agent);
            return yield* SubscriptionRef.get(ref);
          }
          const idle: CliUpdateState = { state: "idle" };
          yield* SubscriptionRef.set(ref, idle);
          return idle;
        }),
    };
  });
