import { AppToolError, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import type { WorkerMachineResize } from "../embedding/worker-machines.ts";

/** The longest one ask may hold a larger size for, in minutes. */
export const MAX_HOLD_MINUTES = 120;

const time = (epochMs: number) => new Date(epochMs).toISOString().slice(11, 16);

/** What the caller is told of a resize that the provider answered. */
export const resizeWords = (
  answered: WorkerMachineResize & { readonly machine: string },
): string => {
  if (answered.kind === "refused") return answered.message;
  const size = answered.size ?? "the size asked for";
  const said = answered.message === undefined ? "" : ` ${answered.message}`;
  switch (answered.state) {
    case "grown":
      return `${answered.machine} now holds ${size}${answered.until === undefined ? "" : ` until ${time(answered.until)} UTC`}. Run the heavy step now, and give it back with size "default" when it is done.`;
    case "waiting":
      return `${answered.machine} asked for ${size}, and its node has no room for it yet: it is applied as soon as there is.${said} Your step may run at the smaller size meanwhile.`;
    case "releasing":
      return `${answered.machine} is going back to ${answered.start ?? "the size it started at"}.${said}`;
    case "released":
      return `${answered.machine} runs at ${answered.start ?? answered.size ?? "the size it started at"} again.`;
    case "infeasible":
      return `${answered.machine}'s node can never hold ${size}, so it kept the size it had.${said} Run the step there, or ask for a smaller size.`;
  }
};

/** The `request_resources` tool, over the sandbox planner's `resize` (`worker-sandbox.ts`). */
export const makeRequestResources = (
  resize: (
    caller: ThreadId,
    input: {
      readonly size: string;
      readonly minutes?: number | undefined;
      readonly reason?: string | undefined;
    },
  ) => Effect.Effect<WorkerMachineResize & { readonly machine: string }, AppToolError>,
) =>
  defineAppTool({
    descriptor: {
      name: "request_resources",
      class: "self",
      description: `On a hosted machine of your own or one you share, which runs small: before a heavy step (full checks, a big build, many tests) ask for \`size\` \`large\` (\`xlarge\` where allowed) for \`minutes\` (30 unless given) with a \`reason\`, and give it back with \`default\` after. Asking again extends it. On a shared machine the hold is yours: the machine holds the largest any worker on it asked for.`,
    },
    audience: ["worker"],
    input: Schema.Struct({
      size: Schema.NonEmptyString.check(Schema.isMaxLength(40)),
      minutes: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HOLD_MINUTES })),
      ),
      reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    }),
    handle: (caller, input) =>
      resize(caller, input).pipe(
        Effect.flatMap((answered) =>
          answered.kind === "refused"
            ? Effect.fail(
                new AppToolError({ tool: "request_resources", message: answered.message }),
              )
            : Effect.succeed({
                machine: answered.machine,
                state: answered.state,
                ...(answered.size === undefined ? {} : { size: answered.size }),
                ...(answered.until === undefined
                  ? {}
                  : { until: new Date(answered.until).toISOString() }),
                said: resizeWords(answered),
              }),
        ),
      ),
  });
