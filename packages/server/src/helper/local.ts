import {
  CODEX_HELPER_RESTRICTION,
  HelperTransportError,
  type HelperCall,
  type HelperReply,
} from "@gram/agents";
import { CODEX_GUIDED_HELPER_DETAIL } from "@gram/agents/codex";
import type { HelperProviderStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { AgentHosts } from "../runtime/agent-hosts.ts";

export interface LocalHelperTransport {
  readonly inspect: Effect.Effect<ReadonlyArray<HelperProviderStatus>>;
  readonly generate: (
    provider: "claude" | "codex",
    call: HelperCall,
  ) => Effect.Effect<HelperReply, HelperTransportError>;
}

/** The adapter owns credentials and process isolation; the scheduler only sees safe summaries. */
export const localHelperTransport = (hosts: AgentHosts["Service"]): LocalHelperTransport => ({
  inspect: Effect.all(
    (["claude", "codex"] as const).map((provider) =>
      hosts.get(provider).pipe(
        Effect.flatMap((host) =>
          host.helper === undefined
            ? Effect.succeed<HelperProviderStatus>({
                provider,
                state: "restriction",
                models: [],
                detail:
                  provider === "codex"
                    ? CODEX_HELPER_RESTRICTION
                    : "This Claude adapter has no verified tool-free helper transport.",
              })
            : host.helper.models.pipe(
                Effect.map((models): HelperProviderStatus => ({
                  provider,
                  state: "ready",
                  models,
                  mode: host.helper?.mode ?? "tool-free",
                  detail:
                    host.helper?.mode === "guided"
                      ? CODEX_GUIDED_HELPER_DETAIL
                      : "Uses this CLI's existing subscription login. The provider decides access and usage limits when a call starts.",
                })),
                Effect.catch((error) =>
                  Effect.succeed<HelperProviderStatus>({
                    provider,
                    state:
                      error.failure === "auth"
                        ? "auth"
                        : error.failure === "restriction"
                          ? "restriction"
                          : "unavailable",
                    models: [],
                    detail:
                      error.detail ??
                      (error.failure === "auth"
                        ? `Sign into ${provider === "claude" ? "Claude Code with /login" : "Codex with codex login"}, then retry.`
                        : error.failure === "restriction"
                          ? `${provider === "codex" ? "Codex did not verify the guided helper controls" : "Claude did not verify tool-free restrictions"}. No helper context was sent.`
                          : "Local helper discovery failed. Retry after checking the installed CLI."),
                  }),
                ),
              ),
        ),
        Effect.catch(() =>
          Effect.succeed<HelperProviderStatus>({
            provider,
            state: "unavailable",
            models: [],
            detail: "Install and sign into this agent CLI, then retry.",
          }),
        ),
      ),
    ),
  ),
  generate: (provider, call) =>
    hosts.get(provider).pipe(
      Effect.mapError(() => new HelperTransportError({ failure: "unavailable" })),
      Effect.flatMap((host) =>
        host.helper === undefined
          ? Effect.fail(new HelperTransportError({ failure: "restriction" }))
          : host.helper.generate(call),
      ),
    ),
});
