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

const PART_TIMEOUT_MS = 20_000;

const MODELS_SENT = 64;

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
    const found = probed.found || listed !== undefined;
    return {
      ...probed,
      found,
      ...(listed === undefined
        ? {}
        : { models: listed.models.slice(0, MODELS_SENT).map(hostModelOf) }),
    };
  });
