// Pure helpers of this machine as a personal device (`hosted-device.ts`), apart from its wiring.

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
