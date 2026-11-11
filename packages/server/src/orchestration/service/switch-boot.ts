// What an orchestrator's switch adds to the boot digest of the session it opened: the handoff note
// the checkpoint wrote (or limit mode's request for one) and the last exchanges with the user,
// fenced as material through the same path any thread's handoff takes (`switch-handoff.ts`).

import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../../persistence/thread-store.ts";
import {
  ORCHESTRATOR_EXCHANGES,
  ORCHESTRATOR_LIMIT_TURNS_TOKENS,
  ORCHESTRATOR_TURNS_TOKENS,
  renderOrchestratorHandoff,
  renderRecentTurns,
  userExchanges,
} from "../../runtime/switch-handoff.ts";
import type { SwitchBoot } from "../outbox.ts";
import { fromStoredMessages } from "../transcripts.ts";

/**
 * How far back the boot digest looks for the exchanges with the user, in stored messages. An
 * orchestrator's transcript is mostly digests and tool calls; this bounds the read, not the text.
 */
export const SWITCH_BOOT_SCAN = 400;

/** The recent turns' budget for `boot`: limit mode's is twice the normal one. */
export const switchBootTurnsTokens = (boot: Pick<SwitchBoot, "noteMode">): number =>
  boot.noteMode === "limit" ? ORCHESTRATOR_LIMIT_TURNS_TOKENS : ORCHESTRATOR_TURNS_TOKENS;

/**
 * The boot digest's note for an orchestrator switch: `renderOrchestratorHandoff` over the note and
 * the last `ORCHESTRATOR_EXCHANGES` exchanges with the user before the switch's divider.
 */
export const switchBootNote = (
  store: Pick<ThreadStoreShape, "lastMessages">,
  threadId: ThreadId,
  boot: SwitchBoot,
) =>
  Effect.gen(function* () {
    const tail = yield* store.lastMessages(threadId, SWITCH_BOOT_SCAN);
    const { messages, earlierNote } = userExchanges(tail, boot.at, ORCHESTRATOR_EXCHANGES);
    const turns = renderRecentTurns(
      fromStoredMessages(messages.map((message, seq) => ({ seq, message }))),
      switchBootTurnsTokens(boot),
      "this orchestrator's exchanges with the user",
    );
    return renderOrchestratorHandoff({
      from: boot.from,
      to: boot.to,
      noteMode: boot.noteMode,
      note: boot.note,
      earlierNote,
      limit: boot.limit,
      turns: turns.text,
    });
  });
