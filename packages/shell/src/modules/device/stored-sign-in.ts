// A sign-in to a hosted server as this computer keeps it in its secrets (`hosted-device.ts`): who
// signed in, the refresh token, and this device's id there. Read field by field, or not at all.

import type { DeviceId } from "@gram/contracts";

export interface StoredSignIn {
  readonly subject: string;
  readonly refreshToken: string;
  readonly deviceId: DeviceId;
  /** Older sign-ins always registered. False means this grant can use the server without lending. */
  readonly deviceRegistered?: boolean;
}

export const parseSignIn = (text: string | undefined): StoredSignIn | undefined => {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<StoredSignIn>;
    return typeof value.subject === "string" &&
      typeof value.refreshToken === "string" &&
      typeof value.deviceId === "string" &&
      (value.deviceRegistered === undefined || typeof value.deviceRegistered === "boolean")
      ? (value as StoredSignIn)
      : undefined;
  } catch {
    return undefined;
  }
};
