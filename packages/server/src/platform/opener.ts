import { spawn, type SpawnOptions } from "node:child_process";
import { batchFileInvocation, InvalidState } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface LaunchSpec {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * Runs through the shell, as Windows `.cmd` shims need. The file and arguments are escaped for
   * `cmd.exe`, so `%VAR%`, `^` and `&` in a path reach the program literally.
   */
  readonly shell?: boolean | undefined;
  /** Passes `args` to the program as-is on Windows, as `explorer /select,"…"` needs. */
  readonly verbatim?: boolean | undefined;
  /**
   * Shows the program's window. Off by default, so a console program flashes no console on
   * Windows, but Explorer obeys the hidden flag too: started with it, the folder opens in a window
   * nobody can see.
   */
  readonly window?: boolean | undefined;
}

export interface OpenerShape {
  /** Starts `spec` detached with no stdio; succeeds once the program has started. */
  readonly launch: (spec: LaunchSpec) => Effect.Effect<void, InvalidState>;
  /**
   * Fails while this server starts no programs at all (`fenceOpener`), so a caller can refuse
   * before it reads a path or a setting. Absent, programs may be started.
   */
  readonly refused?: Effect.Effect<void, InvalidState> | undefined;
}

/** What `spawn` gets for `spec`: a shell launch (a Windows `.cmd` shim) carries cmd.exe escaping. */
export const spawnInvocation = ({
  file,
  args,
  shell = false,
}: Pick<LaunchSpec, "file" | "args" | "shell">): {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
} => (shell ? batchFileInvocation(file, args) : { file, args });

/** The `spawn` options for `spec`: detached, no stdio, hidden unless it asks for its `window`. */
export const spawnOptions = ({
  cwd,
  env,
  shell = false,
  verbatim = false,
  window = false,
}: Omit<LaunchSpec, "file" | "args">): SpawnOptions => ({
  ...(cwd === undefined ? {} : { cwd }),
  ...(env === undefined ? {} : { env }),
  shell,
  detached: true,
  stdio: "ignore",
  windowsHide: !window,
  windowsVerbatimArguments: verbatim,
});

/**
 * How the server starts programs for the user: a folder in the file manager, a file in an editor, a
 * link in the browser. Each caller builds its own platform command. The default starts nothing and
 * fails, so tests never open a real window; `main.ts` provides `OpenerLive`.
 */
export const Opener = Context.Reference<OpenerShape>("@gram/server/Opener", {
  defaultValue: () => ({
    launch: ({ file }) => Effect.fail(new InvalidState({ message: `Can't start ${file} here` })),
  }),
});

const failure = (file: string, error: unknown) =>
  new InvalidState({
    message: `Couldn't start ${file}: ${error instanceof Error ? error.message : String(error)}`,
  });

/**
 * Spawns detached with no stdio, so the program outlives neither a pipe nor the server, and tells
 * `onLaunched` its pid: the desktop shell spares it when it kills the server's tree.
 */
export const makeNodeOpener = (onLaunched: (pid: number) => void = () => {}): OpenerShape => ({
  launch: ({ file, args, ...options }) =>
    Effect.callback<void, InvalidState>((resume) => {
      try {
        const invocation = spawnInvocation({ file, args, shell: options.shell });
        const child = spawn(invocation.file, [...invocation.args], spawnOptions(options));
        child.once("error", (error) => resume(Effect.fail(failure(file, error))));
        child.once("spawn", () => {
          child.unref();
          if (child.pid !== undefined) onLaunched(child.pid);
          resume(Effect.void);
        });
      } catch (error) {
        resume(Effect.fail(failure(file, error)));
      }
    }),
});

/**
 * Why a server with no local user starts no program: one people reach through a fronting proxy, or
 * a headless one. Its users are not at this machine, so an editor, a file manager or a browser
 * opened here would show nobody anything, and would run as the server's own user.
 */
export const NO_LOCAL_PROGRAMS =
  "This Gram runs on a server, and starts no programs on it: open files and links on your own machine.";

/**
 * `inner`, refusing every launch while `refuse` says so, before anything is started. Asked on
 * each launch, so a setting that turns the fence on or off takes effect at once.
 */
export const fenceOpener = (inner: OpenerShape, refuse: Effect.Effect<boolean>): OpenerShape => {
  const refused = Effect.flatMap(refuse, (fenced) =>
    fenced ? Effect.fail(new InvalidState({ message: NO_LOCAL_PROGRAMS })) : Effect.void,
  ).pipe(Effect.andThen(inner.refused ?? Effect.void));
  return { refused, launch: (spec) => Effect.andThen(refused, inner.launch(spec)) };
};

/** An opener that starts nothing, ever: a headless server's (`GRAM_HEADLESS=1`). */
export const OpenerRefused: Layer.Layer<never> = Layer.succeed(
  Opener,
  fenceOpener(
    { launch: () => Effect.fail(new InvalidState({ message: NO_LOCAL_PROGRAMS })) },
    Effect.succeed(true),
  ),
);

/** The real opener, reporting each program it starts to `onLaunched`. */
export const OpenerLive = (onLaunched?: (pid: number) => void): Layer.Layer<never> =>
  Layer.succeed(Opener, makeNodeOpener(onLaunched));
