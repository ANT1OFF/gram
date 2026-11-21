import type { AgentHost } from "@gram/agents";
import type { AgentUnavailable, HostAntigravityStatus, HostGrokStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { parseToolVersion } from "../launch-checks/checks.ts";
import { hostModelOf, loginShell, type ShellRun } from "./claude-sign-in.ts";

const PART_TIMEOUT_MS = 20_000;

const MODELS_SENT = 64;

const probeCli = (command: string, run: ShellRun): Promise<{ found: boolean; version?: string }> =>
  run(`command -v ${command} >/dev/null 2>&1 && ${command} --version`).then(
    ({ code, stdout }) => {
      if (code !== 0) return { found: false };
      const version = parseToolVersion(stdout)?.slice(0, 64);
      return { found: true, ...(version === undefined ? {} : { version }) };
    },
    () => ({ found: false }),
  );

const cliStatusOf = (
  command: string,
  agent: Effect.Effect<AgentHost, AgentUnavailable>,
  run: ShellRun,
): Effect.Effect<HostGrokStatus> =>
  Effect.gen(function* () {
    const probe = Effect.promise(() => probeCli(command, run));
    const host = yield* agent.pipe(Effect.option);
    if (host._tag === "None") return yield* probe;
    const [probed, listed] = yield* Effect.all(
      [
        probe,
        host.value.listModels().pipe(
          Effect.map((models) => ({ models })),
          Effect.timeoutOrElse({
            duration: PART_TIMEOUT_MS,
            orElse: () => Effect.succeed(undefined),
          }),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const found = probed.found || listed !== undefined;
    return {
      ...probed,
      found,
      ...(listed === undefined
        ? {}
        : { models: listed.models.slice(0, MODELS_SENT).map(hostModelOf) }),
    };
  });

/** What the machine's Grok Build can run now (`cliStatusOf`). */
export const grokStatusOf = (
  grok: Effect.Effect<AgentHost, AgentUnavailable>,
  run: ShellRun = loginShell,
): Effect.Effect<HostGrokStatus> => cliStatusOf("grok", grok, run);

/** What the machine's Antigravity can run now (`cliStatusOf`). */
export const antigravityStatusOf = (
  antigravity: Effect.Effect<AgentHost, AgentUnavailable>,
  run: ShellRun = loginShell,
): Effect.Effect<HostAntigravityStatus> => cliStatusOf("agy", antigravity, run);
