import type { PeopleApi } from "./types";

/**
 * `PeopleApi` for the mock: signed in as `person-you`, with a name for each colleague a mock
 * thread works for (`Thread.startedBy`). Mock threads work for nobody unless a scenario says.
 */
export function createPeopleMock(names: ReadonlyMap<string, string> = MOCK_PEOPLE): PeopleApi {
  return {
    peopleNames: async (ids) => ({
      you: MOCK_YOU,
      people: ids.flatMap((id) => {
        const name = names.get(id);
        return name === undefined ? [] : [{ id, name }];
      }),
    }),
  };
}

/** Whom the mock is signed in as. */
export const MOCK_YOU = "person-you";

/** The colleagues the mock's shared Board names. */
export const MOCK_PEOPLE: ReadonlyMap<string, string> = new Map([["person-grace", "Grace"]]);
