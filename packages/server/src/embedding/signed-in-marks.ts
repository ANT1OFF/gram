// The marks of a desktop's hosted sign-ins as this Gram knows them (`signed-in-workers.ts`): each
// sign-in's machines and stops moved from the marks it had before to its mark now, and the mark it
// has now for a source made before it changed (`SignedInDeps.markOf`).

import * as Effect from "effect/Effect";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import type { OwedStops } from "./worker-machine-stops.ts";

/** One sign-in's marks, as the app tells them (`marks`) or the server it asks of (`server`). */
export interface SignInMarks {
  readonly origin: string;
  readonly account?: string | undefined;
  readonly formerAccounts?: ReadonlyArray<string> | undefined;
}

export const signInMarks = (
  port: Pick<WorkerMachinePortShape, "marks">,
  hosts: { readonly machines: Pick<RemoteHostsShape["machines"], "remark"> },
  owed: Pick<OwedStops, "remark">,
) => {
  /** Each origin's sign-in's marks as last told: its mark now, and those it had before. */
  const latest = new Map<string, { account: string; formerAccounts: ReadonlyArray<string> }>();
  /** The mark a sign-in at `origin` has now, for one it had; undefined if it isn't known. */
  const markOf = (origin: string, account: string) => {
    const marks = latest.get(origin);
    return marks !== undefined &&
      (marks.account === account || marks.formerAccounts.includes(account))
      ? marks.account
      : undefined;
  };
  /**
   * Moves one sign-in's machines and stops from its former marks to its mark. Each ledger's move
   * is whole or not at all, and asked for again at every pass, so one that failed, or that a
   * restart cut short between the two, is finished by a later one: the app keeps the former
   * marks for as long as the sign-in lasts, and answers what is asked under them meanwhile.
   */
  const adopt = (marks: SignInMarks) => {
    const account = marks.account;
    if (account === undefined) return;
    const before = latest.get(marks.origin);
    latest.set(marks.origin, {
      account,
      formerAccounts:
        marks.formerAccounts ?? (before?.account === account ? before.formerAccounts : []),
    });
    for (const former of marks.formerAccounts ?? []) {
      if (former === account) continue;
      try {
        hosts.machines.remark(marks.origin, former, account);
      } catch {
        // Not written, so not moved: the next pass moves it.
      }
      owed.remark(marks.origin, former, account);
    }
  };
  /** Every sign-in's move, paused or not, whichever of them new machines are asked of. */
  const adoptAll = port.marks().pipe(
    Effect.tap((marks) => Effect.sync(() => marks.forEach(adopt))),
    Effect.catchCause((cause) => Effect.logWarning("moving former sign-in marks failed", cause)),
  );
  return { adopt, adoptAll, markOf };
};
