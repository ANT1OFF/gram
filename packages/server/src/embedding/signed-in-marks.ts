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
  const latest = new Map<string, { account: string; formerAccounts: ReadonlyArray<string> }>();
  const markOf = (origin: string, account: string) => {
    const marks = latest.get(origin);
    return marks !== undefined &&
      (marks.account === account || marks.formerAccounts.includes(account))
      ? marks.account
      : undefined;
  };
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
      } catch (_notWrittenSoNotMovedTheNextPassMoves) {}
      owed.remark(marks.origin, former, account);
    }
  };
  const adoptAll = port.marks().pipe(
    Effect.tap((marks) => Effect.sync(() => marks.forEach(adopt))),
    Effect.catchCause((cause) => Effect.logWarning("moving former sign-in marks failed", cause)),
  );
  return { adopt, adoptAll, markOf };
};
