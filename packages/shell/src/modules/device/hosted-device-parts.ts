import { randomBytes } from "node:crypto";

import type { DeviceCapability, HostedWorkspace } from "@gram/contracts";

/** What a workspace's lent machine may do; a workspace whose policy isn't known gets nothing. */
export const capabilitiesOf = (
  policy: HostedWorkspace["devices"] | undefined,
  readOnly: boolean,
): ReadonlyArray<DeviceCapability> =>
  policy === undefined || policy === "off"
    ? []
    : policy === "on" && !readOnly
      ? ["read", "exec"]
      : ["read"];

/** A new lent folder's id. */
export const folderId = () => `f-${randomBytes(8).toString("hex")}`;

/** A server's host as it is shown, or its origin as given where it isn't an address. */
export const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * The server a sign-in's keeper is for, once it is made, and where the sign-in's new mark goes
 * (`signInKeeper`'s `marked`): to that server, whether the mark comes before it or after.
 * `changed` is told each time a server's mark does.
 */
export const markTaker = <
  S extends { machineMark: string | undefined; formerMarks: ReadonlyArray<string> },
>(
  changed: () => void,
) => {
  let server: S | undefined;
  let marked:
    | { readonly machineMark: string; readonly formerMarks: ReadonlyArray<string> }
    | undefined;
  return {
    marked: (machineMark: string, formerMarks: ReadonlyArray<string>) => {
      marked = { machineMark, formerMarks };
      if (server === undefined) return;
      Object.assign(server, marked);
      changed();
    },
    take: (made: S) => {
      server = made;
      if (marked !== undefined) Object.assign(made, marked);
    },
    /** Acts on the server, if it is made yet. */
    with: (act: (made: S) => void) => {
      if (server !== undefined) act(server);
    },
  };
};
