import { awaitsSignIn, type Connector, type ThreadId } from "@gram/contracts";
import { create } from "zustand";

import { openExternalUrl } from "@/api/open-external";
import type { Api } from "@/api/types";

/** How long a sign-in the user started is watched for, and how often the list is read meanwhile. */
const SIGN_IN_WAIT_MS = 5 * 60_000;
export const SIGN_IN_POLL_MS = 2_000;

/** A sign-in under way: when it began, and its page again in case the browser tab got lost. */
export interface PendingSignIn {
  readonly since: number;
  readonly url?: string;
}

type SignIns = Readonly<Record<string, PendingSignIn>>;

/**
 * The connector sign-ins under way, per thread, whether the Connectors panel or the thread's
 * lapsed-connector notice started them, so either shows the other's and the list is read while one
 * lasts. Reading the list is what has Claude Code reconnect a claude.ai connector, whose sign-in
 * page calls nobody back.
 */
const useConnectorSignIns = create<{ readonly byThread: Readonly<Record<string, SignIns>> }>(
  () => ({ byThread: {} }),
);

const NONE: SignIns = {};

/** The thread's sign-ins under way, by connector name. */
export const useThreadSignIns = (threadId: ThreadId): SignIns =>
  useConnectorSignIns((s) => s.byThread[threadId] ?? NONE);

/** Stops watching `names`' sign-ins in the thread. */
const forgetSignIns = (threadId: ThreadId, names: ReadonlyArray<string>): void =>
  useConnectorSignIns.setState((s) => {
    const current = s.byThread[threadId] ?? NONE;
    return {
      byThread: {
        ...s.byThread,
        [threadId]: Object.fromEntries(
          Object.entries(current).filter(([name]) => !names.includes(name)),
        ),
      },
    };
  });

/**
 * Starts the agent's own sign-in to `name` and opens its page, calling `onStarted` once the agent
 * has it under way. The sign-in is watched until a listing settles it, or for `SIGN_IN_WAIT_MS`:
 * the user may never finish.
 */
export const startConnectorSignIn = async (
  api: Api,
  threadId: ThreadId,
  name: string,
  onStarted?: () => void,
): Promise<void> => {
  const started = await api.authenticateConnector(threadId, name);
  const signIn: PendingSignIn = {
    since: Date.now(),
    ...(started.kind === "open" ? { url: started.authorizationUrl } : {}),
  };
  useConnectorSignIns.setState((s) => ({
    byThread: { ...s.byThread, [threadId]: { ...(s.byThread[threadId] ?? NONE), [name]: signIn } },
  }));
  onStarted?.();
  setTimeout(() => forgetSignIns(threadId, [name]), SIGN_IN_WAIT_MS);
  if (started.kind === "open") await openExternalUrl(api, started.authorizationUrl);
};

/**
 * Ends the thread's sign-ins that `listed` settles, and returns those that connected. A sign-in is
 * over once the server no longer waits on one (`awaitsSignIn`); still connecting isn't an outcome
 * yet, since the agent reconnects the server once it has the token.
 */
const settleSignIns = (
  threadId: ThreadId,
  listed: ReadonlyArray<Connector>,
): ReadonlyArray<string> => {
  const of = (name: string) => listed.find((c) => c.name === name);
  const over = Object.keys(useConnectorSignIns.getState().byThread[threadId] ?? NONE).filter(
    (name) => {
      const connector = of(name);
      return (
        connector === undefined || (!awaitsSignIn(connector) && connector.status !== "pending")
      );
    },
  );
  if (over.length > 0) forgetSignIns(threadId, over);
  return over.filter((name) => of(name)?.status === "connected");
};

/** The thread's connectors, read for the `["connectors", threadId, cold]` query, sign-ins settled. */
export const listConnectorsSettling = async (api: Api, threadId: ThreadId) => {
  const list = await api.listConnectors(threadId);
  const connected = list.live ? settleSignIns(threadId, list.connectors) : [];
  return { list, connected };
};
