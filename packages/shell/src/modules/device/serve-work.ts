import type { SentWorkResult, SentWorkTarget } from "@gram/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { HostedDevice } from "./hosted-device.ts";
import {
  hostedThreadIdOf,
  repositoriesToCheckOf,
  workMessageFrom,
  workToSendOf,
  workWaitFrom,
} from "./work-input.ts";

const NONE: SentWorkResult = { ok: false, why: "Hosted features are off in this app." };
const MALFORMED: SentWorkResult = { ok: false, why: "The request isn't one the app sends." };

const isRequest = Schema.is(
  Schema.Struct({
    type: Schema.Literal("work.request"),
    id: Schema.String.check(Schema.isMaxLength(64)),
    op: Schema.optional(Schema.Unknown),
  }),
);

const Text = (most: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(most));

const decodeWhere = Schema.decodeUnknownOption(
  Schema.Struct({ origin: Text(512), workspaceId: Text(128) }),
);

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
  const { op } = message;
  if (op === "targets") return respond({ ok: true, targets: sentWorkTargets(device) });
  const where = decodeWhere(message);
  if (Option.isNone(where)) return respond(MALFORMED);
  const { origin, workspaceId: workspace } = where.value;
  if (op === "check") {
    const repositories = repositoriesToCheckOf(
      "repositories" in message ? message.repositories : undefined,
    );
    if (repositories === undefined) return respond(MALFORMED);
    return respond(await device.checkWork(origin, workspace, repositories));
  }
  if (op === "machine") {
    const action = "action" in message ? message.action : undefined;
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
    const wait = workWaitFrom(message);
    if (wait === undefined) return respond(MALFORMED);
    return respond(await device.waitWork(origin, workspace, threadId, wait));
  }
  if (op === "message") {
    const said = workMessageFrom(message);
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
      id: message.id,
      result: { ok: false as const, why: "The app couldn't make the call." },
    }))
    .then((response) => {
      if (response !== undefined) reply(response);
    });
};
