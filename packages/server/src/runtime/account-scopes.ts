import type { AgentHosts } from "./agent-hosts.ts";
import { accountOf, machineAccountScope } from "./limit-wait.ts";
import { effectiveCheckout, hostOf, LOCAL_HOST_ID, type Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
const keyOf = (thread: Thread) =>
  JSON.stringify([hostOf(effectiveCheckout(thread)), thread.model.agent]);

/** Remember successful observations. Missing metadata and probe failures are never a switch. */
export const makeAccountScopes = (
  hosts: AgentHosts["Service"],
  threads: ReadonlyArray<Thread>,
  scopeFor: (machine: string, login: string) => string,
) => {
  const known = new Map<string, string | undefined>();
  // A restart must not forget a scoped wait merely because the first auth probe fails.
  for (const thread of threads.toSorted(
    (a, b) => (a.limitWait?.since ?? 0) - (b.limitWait?.since ?? 0),
  )) {
    const wait = thread.limitWait;
    if (
      wait === undefined ||
      wait.cleared !== undefined ||
      wait.cancelled === true ||
      thread.model.profileId !== undefined
    )
      continue;
    const prefix = accountOf(thread.model);
    if (wait.account === prefix && hostOf(effectiveCheckout(thread)) === LOCAL_HOST_ID)
      known.set(keyOf(thread), undefined);
    else if (wait.account.startsWith(`${prefix}/"`)) {
      try {
        const scope: unknown = JSON.parse(wait.account.slice(prefix.length + 1));
        if (typeof scope !== "string") continue;
        const pair: unknown = JSON.parse(scope);
        if (
          Array.isArray(pair) &&
          pair[0] === hostOf(effectiveCheckout(thread)) &&
          typeof pair[1] === "string" &&
          !pair[1].startsWith("thread:")
        )
          known.set(keyOf(thread), scope);
      } catch {
        /* An unrecognized legacy scope is not identity evidence. */
      }
    }
  }
  const observe = (thread: Thread) =>
    Effect.gen(function* () {
      const machine = hostOf(effectiveCheckout(thread));
      const key = keyOf(thread);
      const fallback = () =>
        known.has(key) ? known.get(key) : machineAccountScope(machine, `thread:${thread.id}`);
      if (thread.model.profileId !== undefined)
        return {
          scope: machine === LOCAL_HOST_ID ? undefined : machineAccountScope(machine, "gateway"),
          confirmed: false,
        };
      if (machine !== LOCAL_HOST_ID) return { scope: fallback(), confirmed: false };
      const host = yield* hosts.get(thread.model.agent).pipe(Effect.result);
      if (host._tag === "Failure") return { scope: known.get(key), confirmed: false };
      if (host.success.readAccountScope === undefined)
        return { scope: known.get(key), confirmed: false };
      const probe = yield* host.success.readAccountScope.pipe(Effect.result);
      if (probe._tag === "Failure") return { scope: known.get(key), confirmed: false };
      if (probe.success === undefined) return { scope: fallback(), confirmed: false };
      const scope = scopeFor(machine, probe.success);
      known.set(key, scope);
      return { scope, confirmed: true };
    });
  return {
    scopeFor: (thread: Thread) => observe(thread).pipe(Effect.map((result) => result.scope)),
    quotaFor: (thread: Thread) =>
      observe(thread).pipe(
        Effect.map((result) => accountOf({ ...thread.model, accountScope: result.scope })),
      ),
    changed: (thread: Thread, previous: string) =>
      observe(thread).pipe(
        Effect.map(
          (result) =>
            result.confirmed &&
            accountOf({ ...thread.model, accountScope: result.scope }) !== previous,
        ),
      ),
    remember: (thread: Thread, login: string, previous: string | undefined) => {
      const machine = hostOf(effectiveCheckout(thread));
      const scope = scopeFor(machine, login);
      // A local old process must not replace the fresh CLI observation. On a joined
      // machine, only a new identity for this process updates the shared known login.
      if (!known.has(keyOf(thread)) || (machine !== LOCAL_HOST_ID && scope !== previous))
        known.set(keyOf(thread), scope);
      return scope;
    },
  };
};
