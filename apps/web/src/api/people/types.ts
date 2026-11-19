import type { PeopleNames } from "@gram/contracts";

/** `people.*`: who the people a server's threads work for are (`Thread.startedBy`). */
export interface PeopleApi {
  /** Their names, for those who ever signed in, and the caller's own id as `you`. */
  peopleNames(ids: readonly string[]): Promise<PeopleNames>;
}
