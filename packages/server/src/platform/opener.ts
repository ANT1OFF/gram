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
   * Set on a server that starts no program for anyone: why. A caller refuses with it
   * ({@link refuseFenced}) before it reads any path or setting.
   */
  readonly refusal?: string | undefined;
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

/** What a fenced opener refuses with. */
export const OPENER_FENCED =
  "This Gram is a shared server, which starts no programs on its own machine for the people using it.";

/** Starts nothing, and says so before a caller reads anything: a server with no local user. */
export const fencedOpener: OpenerShape = {
  refusal: OPENER_FENCED,
  launch: () => Effect.fail(new InvalidState({ message: OPENER_FENCED })),
};

/**
 * Whether this server starts programs for nobody: a headless control plane, or one that people
 * sign in to through a fronting proxy (configured, whether or not the hosted features are on
 * yet). Either has no local user whose editor, file manager or browser a program would be.
 */
export const openerFenced = (config: {
  readonly headless?: boolean | undefined;
  readonly frontedIdentity?: unknown;
}): boolean => config.headless === true || config.frontedIdentity !== undefined;

/** Refuses with `opener`'s refusal, if it has one; called first, before any path or setting is read. */
export const refuseFenced = (opener: OpenerShape): Effect.Effect<void, InvalidState> =>
  opener.refusal === undefined
    ? Effect.void
    : Effect.fail(new InvalidState({ message: opener.refusal }));

/**
 * The real opener, reporting each program it starts to `onLaunched`; the fenced one on a server
 * {@link openerFenced} describes, so a new caller is refused by construction.
 */
export const OpenerLive = (
  onLaunched?: (pid: number) => void,
  options: { readonly fenced?: boolean } = {},
): Layer.Layer<never> =>
  Layer.succeed(Opener, options.fenced === true ? fencedOpener : makeNodeOpener(onLaunched));
