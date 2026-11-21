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

/** The signed-in person `key` is {@link personKey} of; `undefined` for the local person's. */
export const signedInPerson = (key: string | undefined): string | undefined =>
  key?.startsWith("id:") === true ? key.slice(3) : undefined;
