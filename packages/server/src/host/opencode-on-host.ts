// A joined machine's OpenCode: the user's own `opencode` there, run by its host as the server runs
// it here (`opencode serve`, one child per host). It reads that machine's own OpenCode config, so
// the providers and keys are whatever the machine was set up with; an embedder that routes
// OpenCode through its own gateway writes that config before the host starts. Nothing here reads
// a credential, and no gateway profile crosses: a profile's key stays with the control plane.

import { GatewayKeyProvider, type AgentHost } from "@gram/agents";
import { type OpenCodeHost, OpenCodeHostLive } from "@gram/agents/opencode";
import type { AgentUnavailable, HostOpenCodeStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parseToolVersion } from "../launch-checks/checks.ts";
import { hostModelOf, loginShell, type ShellRun } from "./claude-sign-in.ts";

/** The machine's OpenCode, with no gateway key: a profile's session never opens on a machine. */
export const hostOpenCodeLive = (): Layer.Layer<OpenCodeHost> =>
  OpenCodeHostLive().pipe(Layer.provide(GatewayKeyProvider.layerNone));

/**
 * How long one part of the OpenCode status may take before it reads as unknown: inside the
 * control plane's wait for the whole status, as for Codex (`codex-on-host.ts`).
 */
const PART_TIMEOUT_MS = 20_000;

/** How many listed models a status carries, as the wire takes. */
const MODELS_SENT = 64;

/** Whether `opencode` is on the login-shell PATH, and its version. */
const probeOpenCode = (run: ShellRun): Promise<{ found: boolean; version?: string }> =>
  run("command -v opencode >/dev/null 2>&1 && opencode --version").then(
    ({ code, stdout }) => {
      if (code !== 0) return { found: false };
      const version = parseToolVersion(stdout)?.slice(0, 64);
      return { found: true, ...(version === undefined ? {} : { version }) };
    },
    () => ({ found: false }),
  );

/**
 * What the machine's OpenCode can run now: whether it is there, and what it lists. A list that
 * fails leaves `models` out, so the control plane says the machine hasn't listed rather than
 * that it lists nothing.
 */
export const openCodeStatusOf = (
  opencode: Effect.Effect<AgentHost, AgentUnavailable>,
  run: ShellRun = loginShell,
): Effect.Effect<HostOpenCodeStatus> =>
  Effect.gen(function* () {
    const probe = Effect.promise(() => probeOpenCode(run));
    const host = yield* opencode.pipe(Effect.option);
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
    // An OpenCode that answered is installed, whatever the login shell's PATH says.
    const found = probed.found || listed !== undefined;
    return {
      ...probed,
      found,
      ...(listed === undefined
        ? {}
        : { models: listed.models.slice(0, MODELS_SENT).map(hostModelOf) }),
    };
  });
