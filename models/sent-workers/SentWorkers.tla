---------------------------- MODULE SentWorkers ----------------------------
(***************************************************************************)
(* Following a worker sent to another server, and messaging it there      *)
(* (packages/server/src/orchestration/sent-workers.ts, `send_message` in  *)
(* app-tools/orchestration-tools.ts). The parts:                          *)
(*                                                                         *)
(*  - The thread there: done; a message accepted and not started yet      *)
(*    ("pending": its sandbox may be waking, which takes minutes, and the *)
(*    server reads it as done until it starts); running; then done with   *)
(*    one more reply.                                                      *)
(*  - The message: the server takes it, then the record here sets        *)
(*    `askedAt` and reads it running again.                                *)
(*  - The follow (`followOnce`): stamps `began`, waits on the server for  *)
(*    a reply after `latest` (or its timeout), then records what it read: *)
(*    an ended state reads running when `askedAt` is after `began`.       *)
(*    Ended, the follow stops; every 30 s the scan follows any sent       *)
(*    worker that reads open.                                              *)
(*                                                                         *)
(* Fixed = TRUE: an ask stays owed (`askPending`) until a read sees the   *)
(* thread there at work or a reply after it; until then an ended state    *)
(* reads running.                                                          *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxMessages, Fixed

VARIABLES
    there,       \* "done", "pending", "running"
    replies,     \* replies there
    msgs,
    mpc,         \* the message call: "idle", "taken"
    asks,        \* times askedAt was written
    askPending,  \* Fixed: an ask no read has seen answered
    state,       \* the record here: "running" or "done"
    heard,       \* replies recorded here
    fpc,         \* the follow: "off", "idle", "waiting"
    began, read  \* asks at the follow's `began`; what its wait read

vars == <<there, replies, msgs, mpc, asks, askPending, state, heard, fpc, began, read>>

Init == /\ there = "running" /\ replies = 0 /\ msgs = 0 /\ mpc = "idle" /\ asks = 0
        /\ askPending = FALSE /\ state = "running" /\ heard = 0 /\ fpc = "idle"
        /\ began = 0 /\ read = [st |-> "running", r |-> 0]

\* ---- there ----
Starts == there = "pending" /\ there' = "running"
          /\ UNCHANGED <<replies, msgs, mpc, asks, askPending, state, heard, fpc, began, read>>
Replies == there = "running" /\ there' = "done" /\ replies' = replies + 1
           /\ UNCHANGED <<msgs, mpc, asks, askPending, state, heard, fpc, began, read>>

\* ---- the orchestrator messages it, once it reads done ----
Message == /\ mpc = "idle" /\ msgs < MaxMessages /\ there = "done" /\ state = "done"
           /\ there' = "pending" /\ msgs' = msgs + 1 /\ mpc' = "taken"
           /\ UNCHANGED <<replies, asks, askPending, state, heard, fpc, began, read>>
Asked == /\ mpc = "taken" /\ mpc' = "idle" /\ asks' = asks + 1
         /\ askPending' = TRUE /\ state' = "running"
         /\ UNCHANGED <<there, replies, msgs, heard, fpc, began, read>>

\* ---- the follow ----
Scan == /\ fpc = "off" /\ state = "running" /\ fpc' = "idle"
        /\ UNCHANGED <<there, replies, msgs, mpc, asks, askPending, state, heard, began, read>>
Begin == /\ fpc = "idle" /\ fpc' = "waiting" /\ began' = asks
         \* the wait answers with the thread as the server reads it: pending reads done
         /\ read' = [st |-> IF there = "pending" THEN "done" ELSE there, r |-> replies]
         /\ UNCHANGED <<there, replies, msgs, mpc, asks, askPending, state, heard>>
Record == /\ fpc = "waiting"
          /\ LET new == read.r > heard
                 ended == read.st = "done"
                 asked == IF Fixed THEN askPending' ELSE asks > began
             IN /\ askPending' = (askPending /\ ended /\ ~new)
                /\ heard' = read.r
                /\ state' = IF ended /\ ~asked THEN "done" ELSE "running"
                /\ fpc' = IF ended /\ ~asked THEN "off" ELSE "idle"
          /\ UNCHANGED <<there, replies, msgs, mpc, asks, began, read>>

Next == Starts \/ Replies \/ Message \/ Asked \/ Scan \/ Begin \/ Record
Spec == Init /\ [][Next]_vars

\* When the record here reads done and no follow runs, every reply there was heard here and none
\* is still to come: the orchestrator waits on nothing that will never be reported.
NoReplyMissed == (fpc = "off" /\ state = "done" /\ mpc = "idle") => (heard = replies /\ there = "done")
=============================================================================
