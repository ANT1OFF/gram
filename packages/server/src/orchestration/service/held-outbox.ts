import type { OutboxState, StoredHeldBrief } from "../outbox.ts";

/**
 * The outbox without the held brief `id`, and that brief: a cancel, or a release that ended (it
 * spawned, or failed for good).
 */
export const withoutHeld = (
  outbox: OutboxState,
  id: string,
): readonly [OutboxState, StoredHeldBrief | undefined] => {
  const held = outbox.heldBriefs ?? [];
  const found = held.find((brief) => brief.id === id);
  if (found === undefined) return [outbox, undefined];
  const kept = held.filter((brief) => brief.id !== id);
  const { heldBriefs: _, ...rest } = outbox;
  return [kept.length === 0 ? rest : { ...rest, heldBriefs: kept }, found];
};

/** The request id a held brief spawns under when its orchestrator gave none. */
export const heldRequestId = (brief: Pick<StoredHeldBrief, "id">) => `held:${brief.id}`;

/**
 * A release's claim on the held brief `id` (models/held-briefs): the brief stays in the outbox
 * until its release ends, so a server that stops mid-spawn releases it again on its next start,
 * and it carries a request id, so that release finishes the worker it half made rather than make a
 * second one.
 */
export const claimedHeld = (
  outbox: OutboxState,
  id: string,
): readonly [OutboxState, StoredHeldBrief | undefined] => {
  const found = outbox.heldBriefs?.find((brief) => brief.id === id);
  if (found === undefined) return [outbox, undefined];
  if (found.input.clientRequestId !== undefined) return [outbox, found];
  const keyed = { ...found, input: { ...found.input, clientRequestId: heldRequestId(found) } };
  return [
    { ...outbox, heldBriefs: outbox.heldBriefs!.map((brief) => (brief.id === id ? keyed : brief)) },
    keyed,
  ];
};

/** The outbox with `brief` held again: in place of its claimed self, or added when it is gone. */
export const heldAgain = (outbox: OutboxState, brief: StoredHeldBrief): OutboxState => {
  const held = outbox.heldBriefs ?? [];
  return {
    ...outbox,
    heldBriefs: held.some((each) => each.id === brief.id)
      ? held.map((each) => (each.id === brief.id ? brief : each))
      : [...held, brief],
  };
};
