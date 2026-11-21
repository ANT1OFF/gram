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
   * as long as the sign-in lasts. Absent on one kept from before: given one at its first renewal.
   */
  readonly machineMark?: string;
  /** Whether `machineMark` is its organisation's (`machineMarkFor`), not one of its own. */
  readonly machineMarkOrg?: true;
  /**
   * The marks this sign-in had before `machineMark`: one of its own, until a renewal named its
   * organisation. What was made under them is its own, and moves to `machineMark`.
   */
  readonly formerMarks?: ReadonlyArray<string>;
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

const MARK = /^[A-Za-z0-9_-]{8,64}$/;

export const parseSignIn = (text: string | undefined): StoredSignIn | undefined => {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<StoredSignIn>;
    return typeof value.subject === "string" &&
      typeof value.refreshToken === "string" &&
      typeof value.deviceId === "string" &&
      (value.deviceRegistered === undefined || typeof value.deviceRegistered === "boolean") &&
      (value.machineMark === undefined ||
        (typeof value.machineMark === "string" && MARK.test(value.machineMark))) &&
      (value.machineMarkOrg === undefined || value.machineMarkOrg === true) &&
      (value.formerMarks === undefined ||
        (Array.isArray(value.formerMarks) &&
          value.formerMarks.length <= 8 &&
          value.formerMarks.every((each) => typeof each === "string" && MARK.test(each))))
      ? (value as StoredSignIn)
      : undefined;
  } catch {
    return undefined;
  }
};
