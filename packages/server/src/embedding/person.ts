// Who a call is made for, where the server knows: the id a fronting proxy's signed statement gave
// the person (`http/fronted-identity.ts`). The RPC layer sets it around each call a signed-in
// person makes (`rpc/actor-guard.ts`); the decision hook reads it for `actor.id` and for who
// answered an approval. Absent everywhere else, and always absent without fronted sign-in.

import * as Context from "effect/Context";

export const ActingPerson = Context.Reference<string | undefined>("@gram/server/ActingPerson", {
  defaultValue: () => undefined,
});

/**
 * The one person of a server nobody signs in to through a proxy: the desktop app's user. A
 * signed-in person's settings are kept under {@link personKey} of their id, which never reads as
 * this.
 */
export const LOCAL_PERSON = "local";

/** Whose own settings a call reads and writes (`person_settings`): the acting person's, else the local person's. */
export const personKey = (acting: string | undefined): string =>
  acting === undefined ? LOCAL_PERSON : `id:${acting}`;
