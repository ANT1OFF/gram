---------------------------- MODULE HeldBriefs ----------------------------
(***************************************************************************)
(* A worker brief held back (a usage limit, a full slot, the spawn       *)
(* breaker) and released later, across restarts of the Gram server. The  *)
(* parts (packages/server/src/orchestration/service/held-spawns.ts):     *)
(*                                                                         *)
(*  - The brief waits in the workspace's outbox (`heldBriefs`).           *)
(*  - `releaseDue`, when the brief is due: `claimHeld`, then `spawnHeld`  *)
(*    (`spawnFor`, service/spawning.ts): record the request id's thread   *)
(*    in `requests` when the brief carries a `clientRequestId`, make the  *)
(*    worktrees and the worker's thread, then send the brief and record   *)
(*    the spawn. A refusal puts the brief back or reports it.             *)
(*  - The server stops between any two steps (a quit, a crash); on start *)
(*    `armLimitResume` releases every due brief again. A worker found by  *)
(*    its request id is the half-made one, finished rather than made     *)
(*    again.                                                              *)
(*                                                                         *)
(* Fixed = TRUE: the claim keeps the brief, marked releasing, with a      *)
(* request id of its own when it had none; it leaves the outbox only once *)
(* the spawn is recorded.                                                 *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS HasRequestId, MaxStops, Fixed

VARIABLES
    brief,     \* "held", "releasing" (Fixed), "gone"
    keyed,     \* the brief names a request id
    pc,        \* the release: "idle", "claimed", "recorded", "made", "sent"
    recorded,  \* requests[key] is written
    threads,   \* worker threads made for this brief
    briefed,   \* the brief reached a worker and the spawn is recorded
    up, stops

vars == <<brief, keyed, pc, recorded, threads, briefed, up, stops>>

Init == /\ brief = "held" /\ keyed = HasRequestId /\ pc = "idle" /\ recorded = FALSE
        /\ threads = 0 /\ briefed = FALSE /\ up = TRUE /\ stops = 0

\* `releaseDue` claims a due brief (a released one too, after a restart, when Fixed).
Claim == /\ up /\ pc = "idle" /\ ~briefed
         /\ brief \in (IF Fixed THEN {"held", "releasing"} ELSE {"held"})
         /\ brief' = IF Fixed THEN "releasing" ELSE "gone"
         /\ keyed' = (keyed \/ Fixed)
         /\ pc' = "claimed"
         /\ UNCHANGED <<recorded, threads, briefed, up, stops>>

\* `spawnFor`: the request's thread id is written before the worktrees.
Record == /\ up /\ pc = "claimed" /\ pc' = "recorded"
          /\ recorded' = (recorded \/ keyed)
          /\ UNCHANGED <<brief, keyed, threads, briefed, up, stops>>

\* Worktrees and the thread: a thread found by the request id is the half-made one.
Make == /\ up /\ pc = "recorded" /\ pc' = "made"
        /\ threads' = IF recorded /\ threads > 0 THEN threads ELSE threads + 1
        /\ UNCHANGED <<brief, keyed, recorded, briefed, up, stops>>

\* The brief is sent and the spawn recorded; then the brief leaves the outbox (Fixed).
Send == /\ up /\ pc = "made" /\ pc' = "sent" /\ briefed' = TRUE
        /\ UNCHANGED <<brief, keyed, recorded, threads, up, stops>>
Done == /\ up /\ pc = "sent" /\ pc' = "idle"
        /\ brief' = "gone"
        /\ UNCHANGED <<keyed, recorded, threads, briefed, up, stops>>

\* The server stops; what was in memory is gone.
Stop == /\ up /\ stops < MaxStops /\ up' = FALSE /\ pc' = "idle" /\ stops' = stops + 1
        /\ UNCHANGED <<brief, keyed, recorded, threads, briefed>>
Start == /\ ~up /\ up' = TRUE
         /\ UNCHANGED <<brief, keyed, pc, recorded, threads, briefed, stops>>

Next == Claim \/ Record \/ Make \/ Send \/ Done \/ Stop \/ Start
Spec == Init /\ [][Next]_vars

\* With the server up and nothing releasing, the brief is either waiting to be released or
\* reached a worker: a held brief is never dropped.
NoneDropped == (up /\ pc = "idle") => (brief # "gone" \/ briefed)

\* One brief makes at most one worker.
OneWorker == threads <= 1
=============================================================================
