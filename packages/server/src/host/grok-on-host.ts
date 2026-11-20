// A joined machine's Grok Build: the `grok` there, run by its host as the server runs it here, on
// that machine's own sign-in, or on the token command its environment names (a sandbox, which holds
// no login of its own). Nothing here reads a credential.

import type { AgentHost } from "@gram/agents";
import type { AgentUnavailable, HostGrokStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { parseToolVersion } from "../launch-checks/checks.ts";
import { hostModelOf, loginShell, type ShellRun } from "./claude-sign-in.ts";

/** How long one part of the Grok Build status may take before it reads as unknown. */
const PART_TIMEOUT_MS = 20_000;

/** How many listed models a status carries, as the wire takes. */
const MODELS_SENT = 64;

/** Whether `grok` is on the login-shell PATH, and its version. */
const probeGrok = (run: ShellRun): Promise<{ found: boolean; version?: string }> =>
  run("command -v grok >/dev/null 2>&1 && grok --version").then(
    ({ code, stdout }) => {
      if (code !== 0) return { found: false };
      const version = parseToolVersion(stdout)?.slice(0, 64);
      return { found: true, ...(version === undefined ? {} : { version }) };
    },
    () => ({ found: false }),
  );

/**
 * What the machine's Grok Build can run now: whether it is there, and what it lists. A list that
 * fails leaves `models` out, so the control plane says the machine hasn't listed rather than that
 * it lists nothing.
 */
export const grokStatusOf = (
  grok: Effect.Effect<AgentHost, AgentUnavailable>,
  run: ShellRun = loginShell,
): Effect.Effect<HostGrokStatus> =>
  Effect.gen(function* () {
    const probe = Effect.promise(() => probeGrok(run));
    const host = yield* grok.pipe(Effect.option);
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
