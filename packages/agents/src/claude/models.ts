import type { HookInput, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AgentModel, ReasoningVariant } from "@gram/contracts";

/** A row of Claude Code's `supportedModels()`, as the model picker offers it. */
export const toAgentModel = (info: ModelInfo): AgentModel => {
  const efforts: ReadonlyArray<ReasoningVariant> = info.supportedEffortLevels ?? [];
  const supportsEffort = info.supportsEffort === true;
  return {
    id: info.value,
    displayName: info.displayName,
    ...(info.description === "" ? {} : { description: info.description }),
    supportsEffort,
    ...(info.supportsFastMode === undefined
      ? {}
      : {
          speeds: info.supportsFastMode
            ? ["standard" as const, "fast" as const]
            : ["standard" as const],
        }),
    ...(supportsEffort && efforts.length > 0 ? { efforts } : {}),
    ...(info.value === "default" ? { isDefault: true } : {}),
    ...(info.resolvedModel === undefined || info.resolvedModel === info.value
      ? {}
      : { resolvedId: info.resolvedModel }),
  };
};

/**
 * The model the user picked from inside the session, as they asked for it (`null` is the CLI's
 * "default"), or `undefined` when the hook reports anything else. A `sdk` switch is our own
 * `setModel`, and `auto` and `resume` aren't a choice the thread should remember.
 */
export const userModelSwitch = (input: HookInput): string | undefined => {
  if (input.hook_event_name !== "PostModelSwitch" || input.agent_id !== undefined) return undefined;
  if (input.source !== "command" && input.source !== "picker") return undefined;
  return input.requested_model ?? "default";
};
