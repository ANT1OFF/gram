// Sends: the checks on `send_message` to a worker and back to
// the orchestrator, the per-pair rate limit, and the once-only send a `clientRequestId` keeps.

import { type ThreadId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { WINDOW_MS } from "../../app-tools/loop-guard.ts";
import { withSentRequest } from "../outbox.ts";
import { checkWorkerSend, refusal } from "../rules.ts";
import {
  toolError,
  pausedFeatureOf,
  type OrchestrationKit,
  underKeysOf,
  callerKey,
} from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";

/** The key an orchestrator's sends to one worker are counted under. */
const sendKey = (callerId: ThreadId, targetId: ThreadId) => `${callerId} ${targetId}`;

/** The send checks, their record, and the once-only send. */
export const makeSends = (kit: OrchestrationKit) => {
  const {
    requireAuthority,
    readOutbox,
    sends,
    findThread,
    requireWorkerSendAuthority,
    authorityOf,
    updateMemo,
    store,
    orchestrationChanged,
    sendLock,
    requireSendAuthority,
    updateOutbox,
  } = kit;

  /** The orchestrator → worker loop guard for one input, whichever tool sends it. */
  const guardSend = (tool: string, callerId: ThreadId, targetId: ThreadId) =>
    Effect.gen(function* () {
      const { state } = yield* requireAuthority(tool, callerId);
      const memo = (yield* readOutbox(state.workspace.id)).workers[targetId];
      const verdict = checkWorkerSend({
        recentSends: sends.get(sendKey(callerId, targetId)) ?? [],
        now: yield* Clock.currentTimeMillis,
        userIntervened: memo?.userIntervened === true,
        paused: state.paused !== undefined,
        pausedFeature: pausedFeatureOf(state, yield* findThread(targetId)),
      });
      if (!verdict.ok) return yield* toolError(tool, refusal(verdict.code, verdict.reason));
    });

  const checkSend: OrchestrationShape["checkSend"] = (callerId, targetId) =>
    guardSend("send_message", callerId, targetId);

  const checkWorkerMessage: OrchestrationShape["checkWorkerMessage"] = (callerId, targetId) =>
    requireWorkerSendAuthority(callerId, targetId).pipe(Effect.asVoid);

  const noteMessage: OrchestrationShape["noteMessage"] = (callerId, targetId) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      if (authority === undefined) return;
      const workspaceId = authority.state.workspace.id;
      const now = yield* Clock.currentTimeMillis;
      const key = sendKey(callerId, targetId);
      sends.set(key, [...(sends.get(key) ?? []).filter((at) => now - at < WINDOW_MS), now]);
      yield* updateMemo(workspaceId, targetId, (memo) => ({
        ...memo,
        messages: memo.messages + 1,
        lastInputAt: now,
      }));
      yield* store.appendOrchestrationEvent(workspaceId, {
        at: now,
        kind: "message",
        data: { threadId: targetId },
      });
      yield* orchestrationChanged(workspaceId);
    });

  const sendOnce: OrchestrationShape["sendOnce"] = (
    callerId,
    clientRequestId,
    targetId,
    fingerprint,
    send,
  ) =>
    underKeysOf(
      sendLock,
      requireSendAuthority(callerId, targetId).pipe(
        Effect.map(({ state }) => [state.workspace.id]),
        Effect.orElseSucceed(() => [callerKey(callerId)]),
      ),
      Effect.gen(function* () {
        const { thread, state } = yield* requireSendAuthority(callerId, targetId);
        const workspaceId = state.workspace.id;
        const sender = thread.spawnedBy === undefined ? undefined : callerId;
        const key =
          sender === undefined ? clientRequestId : JSON.stringify([sender, clientRequestId]);
        const known = (yield* readOutbox(workspaceId)).sentRequests?.[key];
        if (known !== undefined) {
          if (
            known.sender !== sender ||
            known.threadId !== targetId ||
            known.fingerprint !== fingerprint
          ) {
            return yield* toolError(
              "send_message",
              `clientRequestId ${clientRequestId} already sent another message to “${known.title}” [thread ${known.threadId}], so this one wasn't sent. Give a new message a new id.`,
            );
          }
          const { at: _, fingerprint: _fingerprint, sender: _sender, ...sent } = known;
          return { ...sent, repeated: true as const };
        }
        const sent = yield* send;
        const at = yield* Clock.currentTimeMillis;
        yield* updateOutbox(workspaceId, (outbox) => [
          withSentRequest(outbox, key, {
            ...(sender === undefined ? {} : { sender }),
            threadId: sent.threadId,
            title: sent.title,
            delivered: sent.delivered,
            fingerprint,
            at,
          }),
          undefined,
        ]);
        return sent;
      }),
    );

  return { guardSend, checkSend, checkWorkerMessage, noteMessage, sendOnce };
};

/** What `makeSends` makes, for the parts whose `deps` take some of it. */
export type Sends = ReturnType<typeof makeSends>;
