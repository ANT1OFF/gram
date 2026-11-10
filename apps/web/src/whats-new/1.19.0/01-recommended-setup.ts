import type { WhatsNewItem } from "../index";

export default {
  title: "The Recommended setup picks models for you",
  body: "Turn on Recommended setup in Settings → Agents & models and every model slot follows Gram's recommended tier for its kind of work: a lead model for orchestrators, a scoped one for most workers and a cheap one for helpers, with Details listing each tier here. A slot that follows shows sparkles and one you picked shows a pin; Follow recommended sets it back, and a following slot's effort stops at High. The orchestrator knows the tiers, joined machines report the models they have, and turning the setup off can keep the models you run today.",
} satisfies WhatsNewItem;
