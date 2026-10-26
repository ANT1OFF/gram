import { type GramRpcs } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { type Rpc, type RpcGroup, RpcSchema } from "../../platform/unstable.ts";

/** Every RPC handler, keyed by tag. A group file builds a `Partial` of it. */
export type Handlers = Parameters<typeof GramRpcs.of>[0];

/**
 * A defect's class and stack frames, which come from code, and never its message or `name`, which
 * can come from data: a codec failure quotes the value it rejected, a payload or a transcript.
 */
const defectFields = (defect: unknown): Record<string, string> => {
  if (!(defect instanceof Error)) return { defect: typeof defect };
  const header = String(defect);
  const stack = defect.stack ?? "";
  const frames = stack.startsWith(header)
    ? stack
        .slice(header.length)
        .split("\n")
        .filter((line) => /^\s+at /.test(line))
    : [];
  return { defect: defect.constructor.name, frames: frames.join("\n") };
};

const logDefect = (rpc: string, defect: unknown) =>
  Effect.logError("rpc handler died").pipe(Effect.annotateLogs({ rpc, ...defectFields(defect) }));

/**
 * Logs every defect of `group`'s handlers under the RPC's tag, and turns a synchronous throw into a
 * defect of the request (a failing stream for a stream RPC), where the RPC server would otherwise
 * send it to the whole connection.
 */
export const logDefects = <H extends Readonly<Record<string, (...args: never) => unknown>>>(
  group: Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">,
  handlers: H,
): H =>
  Object.fromEntries(
    Object.entries(handlers).map(([rpc, handler]) => {
      const schema = (group.requests.get(rpc) as Rpc.AnyWithProps | undefined)?.successSchema;
      const isStream = schema !== undefined && RpcSchema.isStreamSchema(schema);
      return [
        rpc,
        (...args: Parameters<typeof handler>) => {
          try {
            const result = handler(...args);
            if (Effect.isEffect(result)) {
              return Effect.tapDefect(result, (defect) => logDefect(rpc, defect));
            }
            if (Stream.isStream(result)) {
              return Stream.tapCause(result, (cause) =>
                Effect.forEach(cause.reasons.filter(Cause.isDieReason), (reason) =>
                  logDefect(rpc, reason.defect),
                ),
              );
            }
            return result;
          } catch (defect) {
            const died = Effect.andThen(logDefect(rpc, defect), Effect.die(defect));
            return isStream ? Stream.fromEffect(died) : died;
          }
        },
      ];
    }),
  ) as H;
