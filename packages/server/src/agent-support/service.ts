import type { AppToolRegistryPort } from "@gram/agents";
import {
  type FeatureSupport,
  type HarnessAvailability,
  type LaunchChecks,
  type ModelRef,
  type SelectedHarnessSupport,
  type ThreadId,
  type ThreadIdentity,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ManagedRuntimesShape } from "../agent-runtime/service.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { AgentHosts } from "../runtime/agent-hosts.ts";
import { admittedForRole } from "../orchestration/rules.ts";
import { installedDreamSupport } from "./dream.ts";

const unknown = (reason: string): FeatureSupport => ({ state: "unknown", reason });

/** Pure local account classification; a gateway never inherits a subscription's sign-out. */
const localAvailability = (model: ModelRef, checks: LaunchChecks): HarnessAvailability => {
  const tool = checks.tools.find((row) => row.tool === model.agent);
  if (tool?.found === false)
    return { state: "missing", reason: `Install ${model.agent} in Settings → Agents, then retry.` };
  if (tool === undefined)
    return { state: "unknown", reason: "The selected CLI has not been checked yet." };
  if (tool.unusable !== undefined)
    return { state: "temporarilyUnavailable", reason: tool.unusable };
  const signIn =
    model.agent === "claude"
      ? checks.claudeSignIn
      : model.agent === "codex"
        ? checks.codexSignIn
        : undefined;
  if (signIn === "notSignedIn")
    return {
      state: "signedOut",
      reason: `Sign in with ${model.agent === "claude" ? "claude auth login" : "codex login"}, then retry.`,
    };
  if (signIn === "signedIn") return { state: "available" };
  if (signIn === "apiKey")
    return {
      state: "unknown",
      reason:
        "This CLI reports API-key billing; subscription access and model entitlement are unverified.",
    };
  if (signIn === "thirdParty")
    return {
      state: "unknown",
      reason: "This CLI uses its configured provider; model access is unverified.",
    };
  return {
    state: "unknown",
    reason: "Account availability is unverified; the CLI checks access when you start.",
  };
};

/**
 * Uses existing read-only CLI checks, profile metadata and live command listings. It never opens
 * a session, lists models, calls a helper, refreshes tokens or requests a provider turn.
 */
export const makeAgentSupport = (deps: {
  readonly hosts: AgentHosts["Service"];
  readonly store: Pick<ThreadStoreShape, "listProfiles">;
  readonly checks: { get(refresh: boolean): Effect.Effect<LaunchChecks> };
  readonly managed?: Pick<ManagedRuntimesShape, "source" | "active">;
  readonly registry?: Pick<AppToolRegistryPort, "forThread">;
  readonly identity?: (
    model: ModelRef,
    threadId: ThreadId,
  ) => Effect.Effect<ThreadIdentity | undefined>;
}) => ({
  read: (input: {
    readonly model: ModelRef;
    readonly threadId?: ThreadId;
    readonly refresh?: boolean;
  }): Effect.Effect<SelectedHarnessSupport> =>
    Effect.gen(function* () {
      const { model } = input;
      const host = yield* deps.hosts.get(model.agent).pipe(Effect.option);
      const checks = yield* deps.checks.get(input.refresh === true);
      const tool = checks.tools.find((row) => row.tool === model.agent);
      let version = tool?.version;
      let availability = localAvailability(model, checks);
      if (
        (model.agent === "claude" || model.agent === "codex") &&
        deps.managed !== undefined &&
        (yield* deps.managed.source(model.agent)) === "managed"
      ) {
        const active = yield* deps.managed.active(model.agent);
        version = active?.version;
        availability =
          active === undefined
            ? {
                state: "missing",
                reason:
                  "The selected managed CLI is not installed. Install it in Settings → Agents or select your own CLI.",
              }
            : {
                state: "unknown",
                reason:
                  "The managed CLI's account availability has not been checked; it checks access at start.",
              };
      }
      if (model.profileId !== undefined) {
        const profile = (yield* deps.store.listProfiles).find(
          (each) => each.id === model.profileId,
        );
        // Configured credentials are not proof that a gateway will accept this account/model.
        if (availability.state !== "missing" && availability.state !== "temporarilyUnavailable")
          availability =
            profile === undefined || profile.keyRef === ""
              ? {
                  state: "missing",
                  reason: "Add a key for the selected gateway in Settings → Gateways, then retry.",
                }
              : {
                  state: "unknown",
                  reason:
                    "The selected gateway is configured; account and model access are checked at start.",
                };
      }
      if (host._tag === "None")
        availability = {
          state: "missing",
          reason: `This build has no ${model.agent} adapter. Choose Codex or Claude Code explicitly; the saved conversation is retained.`,
        };
      const identity =
        input.threadId === undefined || deps.identity === undefined
          ? undefined
          : yield* deps.identity(model, input.threadId);
      const compaction: FeatureSupport =
        identity === undefined
          ? unknown("Manual compaction is known after this harness reports its session commands.")
          : identity.commands.some(
                (command) => command.name === "compact" || command.aliases?.includes("compact"),
              )
            ? { state: "supported", evidence: "The selected live session lists /compact." }
            : {
                state: "unsupported",
                reason: "The selected live session does not offer /compact.",
                evidence: "The selected session's command listing",
              };
      const browserRegistered =
        deps.registry
          ?.forThread(input.threadId ?? ("support-preview" as ThreadId), "plain")
          .some((entry) => entry.descriptor.name === "browser_navigate") === true;
      const browser: FeatureSupport =
        host._tag === "Some" && browserRegistered
          ? unknown(
              "Gram's Preview browser tools are registered, but the selected CLI and attached Preview capabilities have not been verified. Host approvals still apply.",
            )
          : unknown(
              "Preview browser support is unverified here; native web search is a separate CLI setting.",
            );
      const dream = installedDreamSupport(model, version);
      const roleSupport = (role: "orchestrator" | "worker"): FeatureSupport =>
        admittedForRole(model.agent, role)
          ? {
              state: "supported",
              evidence: `This harness is admitted for the ${role} role by Gram's orchestration policy.`,
            }
          : {
              state: "unsupported",
              reason: `This harness cannot run as an ${role}. Choose an admitted harness explicitly.`,
              evidence: "Gram's orchestration role policy",
            };
      return {
        model,
        availability,
        checkedAt: checks.checkedAt,
        ...(version === undefined ? {} : { version }),
        ...(dream?.mode === undefined ? {} : { dreamMode: dream.mode }),
        ...(dream?.reason === undefined ? {} : { dreamReason: dream.reason }),
        support: {
          orchestrator: roleSupport("orchestrator"),
          worker: roleSupport("worker"),
          session:
            host._tag === "Some"
              ? {
                  state: "supported",
                  evidence:
                    "Gram has a registered ordinary-session adapter. This does not qualify every CLI feature or model entitlement.",
                }
              : unknown("No session adapter is registered in this build."),
          dream: dream?.dream ?? unknown("This transport has not reported a supported Dream mode."),
          dreamFiles:
            dream?.dreamFiles ??
            unknown("Enforced file-only access has not been verified for this transport."),
          dreamGuided:
            dream?.dreamGuided ??
            unknown("An instruction-guided Dream mode has not been verified for this transport."),
          browser,
          compaction,
          imageInput: unknown(
            "Image input is known only when the selected model's discovery explicitly lists its input modalities.",
          ),
        },
      };
    }),
});
