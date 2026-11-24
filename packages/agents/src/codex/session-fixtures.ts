import { ProfileId } from "@gram/contracts";

/** A gateway profile for the Codex session tests: synthetic, with no key behind it. */
export const profile = {
  id: ProfileId.make("litellm"),
  name: "LiteLLM",
  baseURL: "https://llm.example/v1",
  keyRef: "ref",
  models: [{ id: "gpt-5.5", name: "GPT-5.5", variants: ["low", "high"] as const }],
};

/** A model on that profile, as a thread is opened with it. */
export const gatewayModel = {
  agent: "codex" as const,
  model: "gpt-5.5",
  profileId: profile.id,
  variant: "high" as const,
};
