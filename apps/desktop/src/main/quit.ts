// The quit, from the first ⌘Q (or Quit in a menu, or the last window closing off macOS) to the
// app's exit. Main hides its windows and this runs its steps in order, each within its own
// timeout and all of them within `QUIT_DEADLINE_MS`, logging what each took. Past the deadline, or
// when the user asks (Quit now, or a second quit), it forces: what main started is killed with
// everything under it (`process-tree.ts`), and the app exits. Electron stays out of this module,
// so tests drive it with fakes.

/** The whole quit's bound; past it, the quit is forced. */
export const QUIT_DEADLINE_MS = 10_000;
/** A quit still running after this shows its progress, with Quit now. */
export const SHOW_PROGRESS_AFTER_MS = 1_000;

/** One step of the quit; one that overruns its timeout is logged and the quit goes on. */
export interface QuitStep {
  readonly name: string;
  readonly timeoutMs: number;
  readonly run: () => Promise<unknown>;
}

/** What the server says as it shuts down (`packages/server/src/runtime/shutdown.ts`). */
export interface ServerShutdown {
  /** Agent sessions still to stop. */
  readonly agents: number;
  /** Threads whose work the quit cuts off. */
  readonly working: number;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The `ServerShutdown` in a server message, or null for any other message. */
export function serverShutdownFromMessage(message: unknown): ServerShutdown | null {
  if (typeof message !== "object" || message === null) return null;
  const { type, agents, working } = message as Record<string, unknown>;
  if (type !== "shutdown") return null;
  return { agents: count(agents), working: count(working) };
}

/** What the progress window shows. */
export interface QuitProgress {
  /** The step running; `forcing` once the quit is forced. */
  readonly step: string;
  readonly agents: number;
  readonly working: number;
}

interface QuitLog {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface QuitOptions {
  readonly steps: ReadonlyArray<QuitStep>;
  /** Kills what main started (the server and speech processes) outright, with all under them. */
  readonly terminate: () => void;
  readonly exit: (code: number) => void;
  /** Called once the quit has run `showAfterMs`, then on every change until the exit. */
  readonly onProgress: (progress: QuitProgress) => void;
  readonly log: QuitLog;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  readonly now: () => number;
  readonly deadlineMs?: number;
  readonly showAfterMs?: number;
}

/** `idle` before the quit, `stopping` while its steps run, `exited` once it has called `exit`. */
type QuitState = "idle" | "stopping" | "exited";

export interface Quit {
  /** Starts the quit; while one runs, forces it. */
  request(): void;
  /** Forces the quit: kills what main started, with everything under it, and exits. */
  force(reason: "user" | "deadline"): void;
  /** Takes in what the server reported, for the progress window. */
  report(shutdown: ServerShutdown): void;
  state(): QuitState;
}

export function createQuit(options: QuitOptions): Quit {
  const { log } = options;
  const deadlineMs = options.deadlineMs ?? QUIT_DEADLINE_MS;
  let state: QuitState = "idle";
  let startedAt = 0;
  let step = "";
  let agents = 0;
  let working = 0;
  let shown = false;
  const timers: unknown[] = [];

  const progress = () => {
    if (shown && state === "stopping") options.onProgress({ step, agents, working });
  };

  const exit = (code: number) => {
    if (state === "exited") return;
    state = "exited";
    for (const timer of timers) options.clearTimeout(timer);
    options.exit(code);
  };

  const run = async () => {
    for (const next of options.steps) {
      if (state !== "stopping") return;
      step = next.name;
      progress();
      const at = options.now();
      let timer: unknown;
      const outcome = await Promise.race([
        next.run().then(
          () => "done" as const,
          () => "failed" as const,
        ),
        new Promise<"timeout">((resolve) => {
          timer = options.setTimeout(() => resolve("timeout"), next.timeoutMs);
        }),
      ]);
      options.clearTimeout(timer);
      if (state !== "stopping") return;
      const fields = { step: next.name, ms: options.now() - at, outcome };
      if (outcome === "done") log.info(fields, "quit: step done");
      else log.warn({ ...fields, timeoutMs: next.timeoutMs }, "quit: step didn't finish; going on");
    }
    if (state !== "stopping") return;
    log.info({ ms: options.now() - startedAt }, "quit: done");
    exit(0);
  };

  const force = (reason: "user" | "deadline") => {
    if (state !== "stopping") return;
    step = "forcing";
    progress();
    log.warn({ reason, step, ms: options.now() - startedAt }, "quit: forced");
    options.terminate();
    exit(0);
  };

  return {
    request() {
      if (state === "stopping") return force("user");
      if (state !== "idle") return;
      state = "stopping";
      startedAt = options.now();
      log.info({ steps: options.steps.map((s) => s.name) }, "quit: started");
      timers.push(
        options.setTimeout(() => {
          shown = true;
          progress();
        }, options.showAfterMs ?? SHOW_PROGRESS_AFTER_MS),
        options.setTimeout(() => force("deadline"), deadlineMs),
      );
      void run();
    },
    force,
    report(shutdown) {
      if (state !== "stopping") return;
      agents = shutdown.agents;
      working = shutdown.working;
      progress();
    },
    state: () => state,
  };
}

/** The progress window's line under its title. */
export function quitDetail({ step, agents, working }: QuitProgress): string {
  if (step === "forcing") return "Stopping everything now…";
  const parts: string[] = [];
  if (agents > 0) parts.push(`Stopping ${agents} ${agents === 1 ? "agent" : "agents"}`);
  if (working > 0) {
    parts.push(`${working} running ${working === 1 ? "thread is" : "threads are"} interrupted`);
  }
  return parts.length > 0 ? `${parts.join(". ")}.` : "Saving your threads…";
}
