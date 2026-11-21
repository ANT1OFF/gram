import type { SentWorkResult, SentWorkTarget } from "@gram/contracts";

import type { HostedDevice } from "./hosted-device.ts";
import {
  hostedThreadIdOf,
  repositoriesToCheckOf,
  workMessageOf,
  workToSendOf,
  workWaitOf,
} from "./work-input.ts";

const NONE: SentWorkResult = { ok: false, why: "Hosted features are off in this app." };
const MALFORMED: SentWorkResult = { ok: false, why: "The request isn't one the app sends." };

const isRequest = (message: unknown): message is { type: "work.request"; id: string } =>
  typeof message === "object" &&
  message !== null &&
  Reflect.get(message, "type") === "work.request" &&
  typeof Reflect.get(message, "id") === "string" &&
  (Reflect.get(message, "id") as string).length <= 64;

const textOf = (message: object, name: string, most: number): string | undefined => {
  const value = Reflect.get(message, name);
  return typeof value === "string" && value.length > 0 && value.length <= most ? value : undefined;
};

/** Where work may go now: each listed workspace of a server signed in to, not paused, that runs it. */
export const sentWorkTargets = (device: HostedDevice): ReadonlyArray<SentWorkTarget> =>
  device
    .state()
    .servers.filter((server) => server.signedIn && !server.paused && server.runsWork)
    .flatMap((server) =>
      server.workspaces.map((workspace) => ({
        origin: server.origin,
        server: server.name,
        workspaceId: workspace.id,
        workspace: workspace.name,
        organisation: workspace.organisation,
      })),
    );

/** Answers one request from the server, or undefined for any other message. */
export const answerSentWork = async (
  message: unknown,
  device: HostedDevice | undefined,
): Promise<{ type: "work.response"; id: string; result: SentWorkResult } | undefined> => {
  if (!isRequest(message)) return undefined;
  const respond = (result: SentWorkResult) => ({
    type: "work.response" as const,
    id: message.id,
    result,
  });
  if (device === undefined) return respond(NONE);
  const op = Reflect.get(message, "op");
  if (op === "targets") return respond({ ok: true, targets: sentWorkTargets(device) });
  const origin = textOf(message, "origin", 512);
  const workspace = textOf(message, "workspaceId", 128);
  if (origin === undefined || workspace === undefined) return respond(MALFORMED);
  if (op === "check") {
    const repositories = repositoriesToCheckOf(Reflect.get(message, "repositories"));
    if (repositories === undefined) return respond(MALFORMED);
    return respond(await device.checkWork(origin, workspace, repositories));
  }
  if (op === "machine") {
    const action = Reflect.get(message, "action");
    if (action !== "get" && action !== "start") return respond(MALFORMED);
    return respond(await device.machineWork(origin, workspace, action));
  }
  if (op === "send") {
    const work = workToSendOf(message);
    if (work === undefined) return respond(MALFORMED);
    return respond(await device.sendWork(origin, workspace, work));
  }
  const threadId = hostedThreadIdOf(message);
  if (threadId === undefined) return respond(MALFORMED);
  if (op === "wait") {
    const wait = workWaitOf({
      wait: {
        after: Reflect.get(message, "after"),
        until: Reflect.get(message, "until"),
        timeoutSeconds: Reflect.get(message, "timeoutSeconds"),
      },
    });
    if (wait === undefined) return respond(MALFORMED);
    return respond(await device.waitWork(origin, workspace, threadId, wait));
  }
  if (op === "message") {
    const said = workMessageOf({
      message: {
        text: Reflect.get(message, "text"),
        clientKey: Reflect.get(message, "clientKey"),
        mode: Reflect.get(message, "mode"),
      },
    });
    if (said === undefined) return respond(MALFORMED);
    return respond(await device.messageWork(origin, workspace, threadId, said));
  }
  if (op === "stop") return respond(await device.stopWork(origin, workspace, threadId));
  return respond(MALFORMED);
};

/** Serves the server's requests: each answered on `reply`, never thrown. */
export const serveSentWorkMessage = (
  message: unknown,
  device: HostedDevice | undefined,
  reply: (message: unknown) => void,
): void => {
  if (!isRequest(message)) return;
  void answerSentWork(message, device)
    .catch(() => ({
      type: "work.response" as const,
      id: (message as { id: string }).id,
      result: { ok: false as const, why: "The app couldn't make the call." },
    }))
    .then((response) => {
      if (response !== undefined) reply(response);
    });
};
