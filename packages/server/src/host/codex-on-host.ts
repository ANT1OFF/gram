import { homedir } from "node:os";
import { GatewayKeyProvider, type AgentHost } from "@gram/agents";
import { type CodexHost, CodexHostLive } from "@gram/agents/codex";
import type { AgentUnavailable, HostCodexStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { installOutwardRules, removeOutwardRules } from "../gateway/codex-home.ts";
import { ownedCodexProvider, prepareOwnedCodexHome } from "../gateway/codex-owned-home.ts";
import { hostModelOf, loginShell, type ShellRun } from "./claude-sign-in.ts";
import { parseToolVersion } from "../launch-checks/checks.ts";

/**
 * The machine's Codex, its native gated home in `dataDir` (the host's own folder). The app-server's
 * environment is the host's login shell's, so a `CODEX_HOME` or provider key the host was started
 * with (an embedder's, routing Codex through its own gateway) is the one Codex runs on.
 */
export const hostCodexLive = (dataDir: string, home = homedir()): Layer.Layer<CodexHost> =>
  CodexHostLive({
    servers: {
      ownedHome: {
        prepare: (userEnv) => prepareOwnedCodexHome(dataDir, home, userEnv),
        history: (userEnv) => prepareOwnedCodexHome(dataDir, home, userEnv, false),
        refresh: (userEnv) => Effect.asVoid(prepareOwnedCodexHome(dataDir, home, userEnv)),
        provider: (userEnv) => ownedCodexProvider(home, userEnv),
        rules: {
          install: (level) => installOutwardRules(dataDir, level, "owned"),
          remove: removeOutwardRules(dataDir, "owned"),
        },
      },
    },
  }).pipe(Layer.provide(GatewayKeyProvider.layerNone));

const PART_TIMEOUT_MS = 20_000;

const probeCodex = (run: ShellRun): Promise<{ found: boolean; version?: string }> =>
  run("command -v codex >/dev/null 2>&1 && codex --version").then(
    ({ code, stdout }) => {
      if (code !== 0) return { found: false };
      const version = parseToolVersion(stdout)?.slice(0, 64);
      return { found: true, ...(version === undefined ? {} : { version }) };
    },
    () => ({ found: false }),
  );

const MODELS_SENT = 64;

const bounded = <A>(effect: Effect.Effect<A, unknown>, fallback: A): Effect.Effect<A> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: PART_TIMEOUT_MS,
      orElse: () => Effect.succeed(fallback),
    }),
    Effect.catchCause(() => Effect.succeed(fallback)),
  );

/**
 * What the machine's Codex can run now, from its own answers: a ChatGPT login is `signedIn`
 * (`checkWorkspaceSwitch`, which reads the account's kind and nothing of its token); one that lists
 * models without it runs on an API key or a provider of its own (`apiKey`); one that says it needs
 * a login is `notSignedIn`. The classification alone leaves the machine.
 */
export const codexStatusOf = (
  codex: Effect.Effect<AgentHost, AgentUnavailable>,
  run: ShellRun = loginShell,
): Effect.Effect<HostCodexStatus> =>
  Effect.gen(function* () {
    const probe = Effect.promise(() => probeCodex(run));
    const host = yield* codex.pipe(Effect.option);
    if (host._tag === "None")
      return { ...(yield* probe), signIn: "unknown", gateReady: false, autoReview: false } as const;
    const agent = host.value;
    const [probed, chatgpt, listed, gateReady, autoReview] = yield* Effect.all(
      [
        probe,
        bounded(
          (agent.checkWorkspaceSwitch ?? Effect.fail(undefined)).pipe(
            Effect.as("yes" as const),
            Effect.catch((error) =>
              Effect.succeed(
                (error as AgentUnavailable | undefined)?.reason === "not-logged-in"
                  ? ("noAccount" as const)
                  : ("no" as const),
              ),
            ),
          ),
          "no" as const,
        ),
        bounded(
          agent.listModels().pipe(
            Effect.map((models) => ({ models })),
            Effect.catch((error) => Effect.succeed({ failed: error.reason })),
          ),
          { failed: undefined },
        ),
        bounded(agent.nativeGateReady ?? Effect.succeed(false), false),
        bounded(agent.autoReviewReady ?? Effect.succeed(false), false),
      ],
      { concurrency: "unbounded" },
    );
    const signIn: HostCodexStatus["signIn"] =
      chatgpt === "yes"
        ? "signedIn"
        : "models" in listed
          ? "apiKey"
          : listed.failed === "not-logged-in" || chatgpt === "noAccount"
            ? "notSignedIn"
            : "unknown";
    const found = probed.found || "models" in listed || chatgpt === "yes";
    return {
      ...probed,
      found,
      signIn,
      ...("models" in listed
        ? { models: listed.models.slice(0, MODELS_SENT).map(hostModelOf) }
        : {}),
      gateReady,
      autoReview,
    };
  });
