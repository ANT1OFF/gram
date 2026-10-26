import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { GatewayProfile, HelperKind, ReasoningVariant } from "@gram/contracts";
import { generateText, type LanguageModel } from "ai";
import * as Redacted from "effect/Redacted";

/**
 * Everything a helper call sends. There is deliberately no `tools`, `toolChoice` or `activeTools`:
 * helper calls summarise text and must never be able to act (T3 Code's title helper ran with every
 * tool enabled and executed `gh` write commands).
 */
export interface HelperTextCall {
  readonly model: LanguageModel;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly abortSignal: AbortSignal;
  /** Sent as `reasoning_effort`; absent sends nothing, which is all some gateways' models accept. */
  readonly reasoningEffort?: ReasoningVariant | undefined;
}

/** What a call spent. Reasoning tokens are part of `outputTokens`, and billed as output. */
interface HelperTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface HelperTextResult {
  readonly text: string;
  /** Absent when the gateway reported none. */
  readonly usage?: HelperTokenUsage | undefined;
}

export type GenerateHelperText = (call: HelperTextCall) => Promise<HelperTextResult>;

/** `generateText` with exactly the fields of {@link HelperTextCall}, so no tool can slip in. */
export const generateHelperText: GenerateHelperText = async ({
  model,
  system,
  prompt,
  maxOutputTokens,
  abortSignal,
  reasoningEffort,
}) => {
  const result = await generateText({
    model,
    system,
    prompt,
    maxOutputTokens,
    abortSignal,
    // The scheduler owns retries: it knows which failures are worth one and which model to ask.
    maxRetries: 0,
    ...(reasoningEffort === undefined
      ? {}
      : { providerOptions: { openaiCompatible: { reasoningEffort } } }),
  });
  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
};

/**
 * Room for the answer and for the thinking before it. Reasoning models spend hidden tokens first
 * (gpt-5.6-luna 20 to 60 on a title, Gemini Flash up to 400) and they count against this cap: at
 * the 30 a title needs, every one of them came back empty. Turning reasoning off instead isn't
 * portable, since Gemini rejects the parameter and gpt-5-mini ignores it.
 */
export const HELPER_MAX_OUTPUT_TOKENS = 2_000;

/**
 * The chat model for `modelId` on `profile`, its requests tagged so the helper's share of spend
 * shows apart in the gateway's `/v1/usage?tag=helper`.
 */
export const helperLanguageModel = (
  profile: GatewayProfile,
  key: Redacted.Redacted<string>,
  modelId: string,
  kind: HelperKind,
): LanguageModel =>
  createOpenAICompatible({
    name: profile.id,
    baseURL: profile.baseURL,
    apiKey: Redacted.value(key),
    headers: { "x-example-tags": `gram,helper,${kind}` },
  }).chatModel(modelId);
