// What changes by chat share (docs/design/settings-by-chat.md): the user's card, raised by the
// tool's own handler on every call, and the check of the models a change names.

import { AppToolError, type ModelRef, type ThreadId } from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { AgentHosts } from "../runtime/agent-hosts.ts";
import { selectableModels } from "../runtime/model-efforts.ts";
import type { ServerApprovalAnswer } from "../runtime/server-approvals.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";

export const fail = (tool: string, message: string) => new AppToolError({ tool, message });

/** What a card is called in what the agent is told: "settings" or "workspace". */
export type ProposalNoun = "settings" | "workspace";

/**
 * Raises the card in `caller`'s thread and waits for the user, for `ttl` at most. Its only scope is
 * `once` and it offers no rule to remember, so an approval covers this card alone. Succeeds with
 * the user's approval; fails, saying nothing changed, when they declined, the card was withdrawn or
 * it expired.
 */
export const askUser = (
  runtimes: Pick<ThreadRuntimesShape, "requestApproval">,
  caller: ThreadId,
  tool: string,
  ttl: Duration.Duration,
  noun: ProposalNoun,
  card: {
    readonly displayName: string;
    readonly input: Record<string, unknown>;
    readonly description: string;
  },
  logged: Record<string, unknown>,
): Effect.Effect<ServerApprovalAnswer, AppToolError> =>
  Effect.gen(function* () {
    const answer = yield* runtimes
      .requestApproval(caller, {
        toolName: `mcp__gram__${tool}`,
        ...card,
        suggestions: [],
        scopes: ["once"],
      })
      .pipe(
        // The timeout interrupts the wait, which withdraws the card.
        Effect.timeoutOption(ttl),
        Effect.catchTag("ThreadNotFound", () =>
          Effect.fail(fail(tool, "Gram couldn't show the card: this thread is gone.")),
        ),
      );
    if (Option.isNone(answer)) {
      yield* Effect.logInfo(`${noun} proposal expired`).pipe(
        Effect.annotateLogs({ threadId: caller, ...logged }),
      );
      return yield* fail(
        tool,
        `The ${noun} proposal expired: the user didn't answer within ${Duration.format(ttl)}, so the card was withdrawn and nothing changed. Propose it again if it's still wanted.`,
      );
    }
    const answered = answer.value;
    if (answered.decision === "allow") return answered;
    const resolution = answered.resolution;
    const userDeclined =
      resolution === undefined ||
      (resolution.origin === "user" && resolution.reason === "rejected");
    yield* Effect.logInfo(`${noun} proposal declined`).pipe(
      Effect.annotateLogs({
        threadId: caller,
        ...logged,
        reason: resolution?.reason ?? "rejected",
      }),
    );
    return yield* new AppToolError({
      tool,
      message: userDeclined
        ? `The user declined the ${noun} change; nothing changed.`
        : `The ${noun} card was withdrawn (${resolution.reason}); nothing changed.`,
      approvalRequired: true,
      ...(resolution === undefined ? {} : { approvalResolution: resolution }),
    });
  });

/**
 * The models a plan names, checked against what their agent lists, as the pickers do: an unknown
 * model or effort is refused; an agent that can't list its models just now gives a note instead.
 */
export const checkModels = (
  store: Pick<ThreadStore["Service"], "listProfiles" | "getSettings">,
  hosts: AgentHosts["Service"] | undefined,
  tool: string,
  models: ReadonlyArray<ModelRef>,
) =>
  Effect.gen(function* () {
    const notes: Array<string> = [];
    if (hosts === undefined) return notes;
    for (const model of models) {
      const listed = yield* selectableModels(store, hosts, model.agent, model.profileId).pipe(
        Effect.map((choices) => ({ ok: true as const, choices })),
        Effect.catchCause(() => Effect.succeed({ ok: false as const })),
      );
      if (!listed.ok) {
        notes.push(
          `Gram couldn't list ${model.agent}'s models just now, so ${model.agent}:${model.model} wasn't checked.`,
        );
        continue;
      }
      const found = listed.choices.find(
        (option) => option.id === model.model || option.resolvedId === model.model,
      );
      if (found === undefined) {
        return yield* fail(
          tool,
          `${model.agent} has no model ${model.model}. It lists: ${listed.choices
            .slice(0, 16)
            .map((option) => option.id)
            .join(", ")}.`,
        );
      }
      if (
        model.variant !== undefined &&
        found.efforts.length > 0 &&
        !found.efforts.includes(model.variant)
      ) {
        return yield* fail(
          tool,
          `${model.agent}:${model.model} has no ${model.variant} effort; it supports ${found.efforts.join(", ")}.`,
        );
      }
    }
    return notes;
  });
