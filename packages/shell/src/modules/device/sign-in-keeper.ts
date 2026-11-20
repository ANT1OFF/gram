// The token keeper of one kept sign-in (`hosted-device.ts`): what is kept of it is one record,
// the latest, so a rotated refresh token never drops its mark, and one restored from before
// marks were takes its mark from its first renewal.

import type { KeyObject } from "node:crypto";

import type { HostedDiscovery } from "@gram/contracts";
import { type Fetch, HOSTED_SAVE_MS, makeTokenKeeper, type TokenKeeper } from "./hosted.ts";
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
  /** Told the sign-in's new mark, and its former ones, once the mark a renewal gives it is kept. */
  readonly marked?: (mark: string, formerMarks: ReadonlyArray<string>) => void;
  /** How long a new mark's write is waited for before the renewal goes on without it. */
  readonly markWaitMs?: number;
}): TokenKeeper => {
  let stored = options.signIn;
  // One write at a time, in order: a slow one never lands over a newer one.
  let writing: Promise<unknown> = Promise.resolve();
  const write = (next: StoredSignIn): Promise<void> => {
    const done = writing.then(() => options.keep(next));
    writing = done.catch(() => undefined);
    return done;
  };
  /** Whether `next` was written within `ms`: a write that fails or is slow keeps nothing. */
  const writtenWithin = async (next: StoredSignIn, ms: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const kept = await Promise.race([
      write(next).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), ms);
      }),
    ]);
    clearTimeout(timer);
    return kept;
  };
  return makeTokenKeeper({
    discovery: options.discovery,
    key: options.key,
    subject: stored.subject,
    refreshToken: stored.refreshToken,
    saveRefreshToken: (refreshToken) => {
      stored = { ...stored, refreshToken };
      return write(stored);
    },
    // A renewal that names its organisation gives it that organisation's mark, the same as
    // signing in there again (`machineMarkFor`), once: one of its own until then is kept as a
    // former mark, whose machines and stops the server moves to it. One with no mark yet and
    // no organisation named gets one of its own. Either is told, and so used, only once it is
    // kept: a mark used and then lost to a failed write, or a restart before it, would leave
    // what was made under it to no sign-in. Not kept, nothing changes, and the next renewal
    // tries again.
    renewed: async (tokens) => {
      if (stored.machineMarkOrg === true) return;
      if (stored.machineMark !== undefined && tokens.organization === undefined) return;
      const machineMark = machineMarkFor(options.origin, stored.subject, tokens.organization);
      const formerMarks =
        stored.machineMark === undefined
          ? stored.formerMarks
          : [...(stored.formerMarks ?? []), stored.machineMark].slice(-8);
      const next: StoredSignIn = {
        ...stored,
        machineMark,
        ...(tokens.organization === undefined ? {} : { machineMarkOrg: true as const }),
        ...(formerMarks === undefined ? {} : { formerMarks }),
      };
      if (!(await writtenWithin(next, options.markWaitMs ?? HOSTED_SAVE_MS))) return;
      stored = next;
      options.marked?.(machineMark, formerMarks ?? []);
    },
    fetch: options.fetch,
    now: options.now,
    ended: options.ended,
  });
};
