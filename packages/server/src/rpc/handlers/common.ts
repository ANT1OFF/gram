import { fieldsOf, type GramRpcs } from "@gram/contracts";
import { GhCallEnv } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { threadCaller } from "../../embedding/gh-thread.ts";
import { type Rpc, type RpcGroup, RpcSchema } from "../../platform/unstable.ts";

/** Every RPC handler, keyed by tag. A group file builds a `Partial` of it. */
export type Handlers = Parameters<typeof GramRpcs.of>[0];

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

/** The thread a request names by its `threadId`, if it names one. */
export const requestThread = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = fieldsOf(payload).get("threadId");
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

/**
 * Logs every defect of `group`'s handlers under the RPC's tag, and turns a synchronous throw into a
 * defect of the request (a failing stream for a stream RPC), where the RPC server would otherwise
 * send it to the whole connection. A request that names a thread (`threadId`) runs as that
 * thread's (`GhCallEnv`), so every GitHub read it makes is made for that thread.
 */
export const logDefects = <H extends Readonly<Record<string, (...args: never) => unknown>>>(
  group: Pick<RpcGroup.RpcGroup<Rpc.AnyWithProps>, "requests">,
  handlers: H,
): H =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each handler of H is wrapped under its own key with its own parameters and result
  Object.fromEntries(
    Object.entries(handlers).map(([rpc, handler]) => {
      const schema = group.requests.get(rpc)?.successSchema;
      const isStream = schema !== undefined && RpcSchema.isStreamSchema(schema);
      return [
        rpc,
        (...args: Parameters<typeof handler>) => {
          try {
            const result = handler(...args);
            const thread = requestThread(args[0]);
            const caller = thread === undefined ? undefined : threadCaller(thread);
            if (Effect.isEffect(result)) {
              const logged = Effect.tapDefect(result, (defect) => logDefect(rpc, defect));
              return caller === undefined
                ? logged
                : Effect.provideService(logged, GhCallEnv, caller);
            }
            if (Stream.isStream(result)) {
              const logged = Stream.tapCause(result, (cause) =>
                Effect.forEach(cause.reasons.filter(Cause.isDieReason), (reason) =>
                  logDefect(rpc, reason.defect),
                ),
              );
              return caller === undefined
                ? logged
                : Stream.provideService(logged, GhCallEnv, caller);
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
