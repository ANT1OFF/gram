import type { PrStatus } from "@gram/contracts";
import { type Pr, prChecksStamp } from "@gram/git";
import * as Effect from "effect/Effect";
import { asBackground } from "../github/budget.ts";
import { failingCheck } from "./rules.ts";

export const failingChecks = (
  pr: Pr["Service"],
  cwd: string,
  bound: { readonly repo: string; readonly number: number },
  badge: PrStatus,
) =>
  pr.checks(cwd, bound.number, bound.repo, { stamp: prChecksStamp(badge) }).pipe(
    Effect.map((runs) =>
      runs
        .filter((run) => run.status === "failing" && run.name !== "" && run.required !== false)
        .map((run) => failingCheck(run.name, run.link)),
    ),
    Effect.orElseSucceed(() => undefined),
    asBackground,
  );
