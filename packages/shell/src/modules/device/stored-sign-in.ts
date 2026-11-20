// A sign-in to a hosted server as this computer keeps it in its secrets (`hosted-device.ts`): who
// signed in, the refresh token, and this device's id there. Read field by field, or not at all.

import { createHash, randomBytes } from "node:crypto";

import type { DeviceId } from "@gram/contracts";

export interface StoredSignIn {
  readonly subject: string;
  readonly refreshToken: string;
  readonly deviceId: DeviceId;
  /** Older sign-ins always registered. False means this grant can use the server without lending. */
  readonly deviceRegistered?: boolean;
  /**
   * The opaque mark of this sign-in that worker machines asked for under it carry
   * (`WorkerMachineServer.account`, `machineMarkFor`): set once, as it is signed in, and kept for
   * as long as the sign-in lasts. Absent on one kept from before: given one as it is restored.
   */
  readonly machineMark?: string;
}

/**
 * The mark a new sign-in's worker machines carry. Where the server names the organisation the
 * grant is for, the server, that organisation and the person, hashed: the same for every sign-in
 * as that person there, so signing in again reaches what was made before, and no id leaves the
 * app. Where it doesn't, one of this sign-in's own: what a later sign-in makes is never confused
 * with it, though that sign-in no longer acts on it.
 */
export const machineMarkFor = (origin: string, subject: string, organization?: string) =>
  organization === undefined
    ? randomBytes(24).toString("base64url")
    : createHash("sha256")
        .update(JSON.stringify([origin, organization, subject]))
        .digest("base64url")
        .slice(0, 32);

export const parseSignIn = (text: string | undefined): StoredSignIn | undefined => {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<StoredSignIn>;
    return typeof value.subject === "string" &&
      typeof value.refreshToken === "string" &&
      typeof value.deviceId === "string" &&
      (value.deviceRegistered === undefined || typeof value.deviceRegistered === "boolean") &&
      (value.machineMark === undefined ||
        (typeof value.machineMark === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value.machineMark)))
      ? (value as StoredSignIn)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The sign-in kept for a server, read back, with its mark (`machineMark`): one kept from before
 * marks were is given its own now, and kept with it from then on.
 */
export const markedSignIn = async (
  origin: string,
  secrets: {
    readonly get: (name: string) => Promise<string | undefined>;
    readonly set: (name: string, value: string) => Promise<void>;
  },
  name: string,
): Promise<StoredSignIn | undefined> => {
  const kept = parseSignIn(await secrets.get(name));
  if (kept === undefined || kept.machineMark !== undefined) return kept;
  const marked = { ...kept, machineMark: machineMarkFor(origin, kept.subject) };
  await secrets.set(name, JSON.stringify(marked));
  return marked;
};
