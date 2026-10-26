// What other services can hold back: a limit wait's resume, an idle thread's queue, and a turn the
// agent opens by itself.

import type { Thread } from "@gram/contracts";
import type * as Effect from "effect/Effect";

/**
 * Asked before a limit wait's timer resumes its thread: `true` holds it back, as a user's hold on a
 * worker or a paused workspace does. The thread stays waiting and is asked again a minute later.
 */
export type ResumeHold = (thread: Thread) => Effect.Effect<boolean>;

/**
 * Asked before an idle thread's queued input or system delivery starts a turn: `true` keeps it all
 * waiting, as the user's pause of a worker's feature does, until `releaseQueue` is called for the
 * thread. One that fails holds too.
 */
export type QueueHold = (thread: Thread) => Effect.Effect<boolean>;

/**
 * Asked as the agent opens a turn by itself (Claude reporting on a background task): `true` stops
 * that turn at its first tool boundary, as a paused workspace does. One that fails holds too.
 */
export type TurnHold = (thread: Thread) => Effect.Effect<boolean>;
