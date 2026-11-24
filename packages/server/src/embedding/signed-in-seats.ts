import * as Effect from "effect/Effect";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import type { WorkerMachineSource } from "./worker-machines.ts";
import { askSeats, parseProvidedMachines, seatsBody } from "./worker-seats.ts";

/**
 * A signed-in server's part of `WorkerMachineSource` for machines several workers share: what it
 * says each size is for, a machine's seats (`…/workers`), and the person's machines there
 * (`…/machines`). Each call is made under the sign-in the machines were asked for under.
 */
export const signedInSeats = (
  port: Pick<WorkerMachinePortShape, "call">,
  origin: string,
  account: () => string | undefined,
  sharing: WorkerMachineSource["sharing"],
): Pick<WorkerMachineSource, "sharing" | "seats" | "machines"> => ({
  sharing,
  seats: (ask) =>
    askSeats(
      ask,
      Effect.suspend(() =>
        port
          .call(origin, "workers", seatsBody(ask), { account: account() })
          .pipe(
            Effect.map((answered) =>
              answered.ok
                ? { status: answered.status, body: answered.body }
                : { failed: answered.why },
            ),
          ),
      ),
    ),
  machines: Effect.suspend(() =>
    port
      .call(origin, "machines", {}, { account: account() })
      .pipe(
        Effect.map((answered) =>
          answered.ok ? parseProvidedMachines(answered.status, answered.body) : undefined,
        ),
      ),
  ),
});
