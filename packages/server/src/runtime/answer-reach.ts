import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { ActingPerson } from "../embedding/person.ts";

/**
 * Who may approve a card the server raised, beyond reaching its thread (`answerAdmission`). It is
 * checked where every answer to such a card is taken (`respondToServer`), whatever brought the
 * answer: the socket's `thread.respond` or `thread.respondMany`, `POST /asks/answer`, or code in
 * this process. Every card names one: there is no default.
 *
 * Declining is open to anyone who may answer the card, so a reach suits a card whose decline only
 * withdraws the change. A card whose decline is kept and acts later (a remembered refusal) needs
 * its own rule for who may decline too: a reach alone would let a paired browser or a member plant
 * one.
 *
 * - `anyone`: whoever may answer the thread. For work on the thread itself, which they may do or
 *   approve directly.
 * - `localApp`: the desktop app on this computer alone ({@link AnsweredInLocalApp}). Never a paired
 *   browser, a person signed in through a proxy, or code in this process. For a card whose approval
 *   does what only the local app may do directly, as `connectors.add` is.
 * - `deployment`: never a person signed in through a proxy (`ActingPerson`), who may not change
 *   the server's own setup directly either (`DEPLOYMENT_RPCS`).
 */
export type ApprovalReach = "anyone" | "localApp" | "deployment";

/**
 * Whether this fiber's answer came over the local app's own connection, as the transport stamped
 * it (`isLocalApp`). Only the socket's answer handlers set it (`rpc/handlers/respond.ts`).
 */
export const AnsweredInLocalApp = Context.Reference<boolean>("@gram/server/AnsweredInLocalApp", {
  defaultValue: () => false,
});

/** `effect` as an answer given in the local app on this computer, for a test that answers in-process. */
export const asLocalAppAnswerForTests = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, AnsweredInLocalApp, true);

export const APPROVE_IN_LOCAL_APP =
  "This can only be approved in Gram on the computer it runs on, not from a paired browser. You can still decline it here.";

export const DEPLOYMENT_APPROVAL =
  "Not yours to approve: this changes the server's own setup, which comes from its deployment, not from the people signed in to it. You can still decline it.";

/** Why this fiber's caller may not approve a card of `reach`; undefined when they may. */
export const reachRefusal = (reach: ApprovalReach): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (reach === "anyone") return undefined;
    if ((yield* ActingPerson) !== undefined) return DEPLOYMENT_APPROVAL;
    if (reach === "localApp" && !(yield* AnsweredInLocalApp)) return APPROVE_IN_LOCAL_APP;
    return undefined;
  });
