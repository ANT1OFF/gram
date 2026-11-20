// The fakes the signed-in worker machine tests share: a desktop app and the hosted server behind
// it, as the server's port sees them, and a machine registered as one that server started.

import { generateHostKey } from "../host/machine-keys.ts";
import type { RemoteHosts } from "../host/remote-hosts.ts";
import type { WorkerMachineMessagePort } from "./signed-in-port.ts";

export const ORIGIN = "https://hosted.example.test";
/** The sign-in machines are asked for under there (`WorkerMachineServer.account`). */
export const ACCOUNT = "account-ada-0123456789";
export const SERVER = { origin: ORIGIN, server: "Example hosted", account: ACCOUNT };
export const NAME = "worker-0123456789";

export type Call = { readonly call: string; readonly body: Record<string, unknown> };

/**
 * The desktop app and the hosted server behind it, as the server's port sees them. `answer` is the
 * server's answer to each call; `relayed` runs when the server asks the app to carry a machine.
 */
export const fakeApp = (options: {
  readonly server?: {
    readonly server?: typeof SERVER & { readonly formerAccounts?: ReadonlyArray<string> };
    readonly why?: string;
  };
  readonly answer: (call: Call) => { readonly status: number; readonly body: unknown };
  readonly relayed?: (name: string, toServer: (message: unknown) => void) => void;
  readonly fromServer?: (message: Record<string, unknown>) => void;
}) => {
  const listeners: Array<(event: { readonly data: unknown }) => void> = [];
  const calls: Call[] = [];
  const asked: string[] = [];
  const toServer = (data: unknown) => {
    queueMicrotask(() => {
      for (const listener of listeners) listener({ data });
    });
  };
  const port: WorkerMachineMessagePort = {
    postMessage: (raw) => {
      const message = raw as Record<string, unknown>;
      if (message["type"] !== "machines.request") {
        options.fromServer?.(message);
        return;
      }
      const respond = (result: unknown) =>
        toServer({ type: "machines.response", id: message["id"], result });
      const op = message["op"] as string;
      asked.push(op);
      if (op === "server") respond({ ok: true, ...(options.server ?? { server: SERVER }) });
      else if (op === "call") {
        const call = {
          call: message["call"] as string,
          body: message["body"] as Record<string, unknown>,
        };
        calls.push(call);
        respond({ ok: true, ...options.answer(call) });
      } else if (op === "relay") {
        options.relayed?.(message["name"] as string, toServer);
        respond({ ok: true });
      } else respond({ ok: true });
    },
    on: (_event, listener) => {
      listeners.push(listener);
    },
  };
  return { port, calls, asked, toServer };
};

export const provisionRelayed = (hosts: RemoteHosts["Service"], name: string) => {
  const key = generateHostKey();
  const result = hosts.machines.provision({
    name,
    publicKey: key.publicKey,
    platform: "linux",
    onDemand: "worker",
    via: ORIGIN,
    viaAccount: ACCOUNT,
  });
  if (result.kind !== "provisioned") throw new Error(result.message);
  return { key, id: result.machine.id };
};
