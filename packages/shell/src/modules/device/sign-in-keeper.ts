// The token keeper of one kept sign-in (`hosted-device.ts`): what is kept of it is one record,
// the latest, so a rotated refresh token never drops its mark, and one restored from before
// marks were takes its mark from its first renewal.

import type { KeyObject } from "node:crypto";

import type { HostedDiscovery } from "@gram/contracts";
import { type Fetch, makeTokenKeeper, type TokenKeeper } from "./hosted.ts";
import { machineMarkFor, type StoredSignIn } from "./stored-sign-in.ts";

export const signInKeeper = (options: {
  readonly origin: string;
  readonly discovery: HostedDiscovery;
  readonly key: KeyObject;
  readonly signIn: StoredSignIn;
  /** Writes the sign-in, as it now is, where it is kept. */
  readonly keep: (stored: StoredSignIn) => Promise<void>;
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly ended: () => void;
  /** Told the sign-in's new mark, and its former ones, as a renewal gives it one. */
  readonly marked?: (mark: string, formerMarks: ReadonlyArray<string>) => void;
}): TokenKeeper => {
  let stored = options.signIn;
  return makeTokenKeeper({
    discovery: options.discovery,
    key: options.key,
    subject: stored.subject,
    refreshToken: stored.refreshToken,
    saveRefreshToken: (refreshToken) => {
      stored = { ...stored, refreshToken };
      return options.keep(stored);
    },
    // A renewal that names its organisation gives it that organisation's mark, the same as
    // signing in there again (`machineMarkFor`), once: one of its own until then is kept as a
    // former mark, whose machines and stops the server moves to it. One with no mark yet and
    // no organisation named gets one of its own.
    renewed: (tokens) => {
      if (stored.machineMarkOrg === true) return;
      if (stored.machineMark !== undefined && tokens.organization === undefined) return;
      const machineMark = machineMarkFor(options.origin, stored.subject, tokens.organization);
      const formerMarks =
        stored.machineMark === undefined
          ? stored.formerMarks
          : [...(stored.formerMarks ?? []), stored.machineMark].slice(-8);
      stored = {
        ...stored,
        machineMark,
        ...(tokens.organization === undefined ? {} : { machineMarkOrg: true as const }),
        ...(formerMarks === undefined ? {} : { formerMarks }),
      };
      options.marked?.(machineMark, formerMarks ?? []);
      void options.keep(stored).catch(() => undefined);
    },
    fetch: options.fetch,
    now: options.now,
    ended: options.ended,
  });
};
