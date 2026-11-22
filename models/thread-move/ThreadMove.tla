---------------------------- MODULE ThreadMove ----------------------------
(***************************************************************************)
(* Moving a thread to another server: the copy here is exported, the     *)
(* other server imports the bundle, and then the copy here is settled:   *)
(* parked, read-only, saying where it went. Meanwhile a person can still *)
(* send to the copy here until it is settled. The parts:                 *)
(*                                                                         *)
(*  - Export (`exportThread`, packages/server/src/transfer/              *)
(*    thread-transfer.ts): refuses a thread mid-turn, keeps its edits on *)
(*    its hidden ref and pushes them (slow: git), reads the history, and *)
(*    stamps the bundle `exportedAt`.                                     *)
(*  - Settle (`settleThread`): refuses when `lastActivityAt` is after    *)
(*    `exportedAt`, rests the session (`restSession`: refuses while it   *)
(*    is working), then writes `transferredTo`.                          *)
(*  - A send (`sendInput`, runtime/message-queue.ts), under the thread's *)
(*    lock: refused once `transferredTo` is set, else the message is     *)
(*    kept and the turn starts; `markRunning` touches `lastActivityAt`   *)
(*    when the agent takes it. A turn ends with the agent's reply and    *)
(*    its edits.                                                          *)
(*  - The clock moves in milliseconds: two steps may read the same one.  *)
(*                                                                         *)
(* StampFirst = TRUE: export stamps `exportedAt` before it checks the    *)
(* status, and settle refuses activity at or after it. SettleLocked =     *)
(* TRUE: settle's checks and its write are one step under the thread's   *)
(* lock. Both FALSE is the code before 22 November 2026.                 *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxSends, MaxClock, StampFirst, SettleLocked

VARIABLES
    clock,
    status,        \* "idle", "starting", "running"
    msgs,          \* messages on the copy here
    edits,         \* turns whose edits are in its worktree
    lastActivity,  \* lastActivityAt
    sends,
    ex,            \* export: "none", "checked", "pushed", "read", "done"
    exportedAt, bundleMsgs, bundleEdits,
    st,            \* settle: "none", "checked", "rested", "settled", "refused"
    movedTo        \* transferredTo is set

vars == <<clock, status, msgs, edits, lastActivity, sends, ex, exportedAt,
          bundleMsgs, bundleEdits, st, movedTo>>

Init ==
    /\ clock = 1 /\ status = "idle" /\ msgs = 0 /\ edits = 0 /\ lastActivity = 0
    /\ sends = 0 /\ ex = "none" /\ exportedAt = 0 /\ bundleMsgs = 0 /\ bundleEdits = 0
    /\ st = "none" /\ movedTo = FALSE

Tick == clock < MaxClock /\ clock' = clock + 1
        /\ UNCHANGED <<status, msgs, edits, lastActivity, sends, ex, exportedAt,
                       bundleMsgs, bundleEdits, st, movedTo>>

\* ---- the person and the agent on the copy here ----
Send == /\ sends < MaxSends /\ ~movedTo /\ status = "idle"
        /\ sends' = sends + 1 /\ msgs' = msgs + 1 /\ status' = "starting"
        /\ UNCHANGED <<clock, edits, lastActivity, ex, exportedAt, bundleMsgs, bundleEdits, st, movedTo>>
TurnStarts == /\ status = "starting" /\ status' = "running" /\ lastActivity' = clock
              /\ UNCHANGED <<clock, msgs, edits, sends, ex, exportedAt, bundleMsgs, bundleEdits, st, movedTo>>
TurnEnds == /\ status = "running" /\ status' = "idle" /\ msgs' = msgs + 1 /\ edits' = edits + 1
            /\ UNCHANGED <<clock, lastActivity, sends, ex, exportedAt, bundleMsgs, bundleEdits, st, movedTo>>

\* ---- export ----
ExportCheck == /\ ex = "none" /\ status = "idle" /\ ex' = "checked"
               /\ exportedAt' = IF StampFirst THEN clock ELSE exportedAt
               /\ UNCHANGED <<clock, status, msgs, edits, lastActivity, sends, bundleMsgs, bundleEdits, st, movedTo>>
ExportPush == /\ ex = "checked" /\ ex' = "pushed" /\ bundleEdits' = edits
              /\ UNCHANGED <<clock, status, msgs, edits, lastActivity, sends, exportedAt, bundleMsgs, st, movedTo>>
ExportRead == /\ ex = "pushed" /\ ex' = "read" /\ bundleMsgs' = msgs
              /\ UNCHANGED <<clock, status, msgs, edits, lastActivity, sends, exportedAt, bundleEdits, st, movedTo>>
ExportStamp == /\ ex = "read" /\ ex' = "done"
               /\ exportedAt' = IF StampFirst THEN exportedAt ELSE clock
               /\ UNCHANGED <<clock, status, msgs, edits, lastActivity, sends, bundleMsgs, bundleEdits, st, movedTo>>

\* ---- settle, once the other server has imported the bundle ----
After(t) == IF StampFirst THEN t >= exportedAt ELSE t > exportedAt
Busy == status \in {"starting", "running"}
SettleCheck == /\ ex = "done" /\ st = "none"
               /\ IF SettleLocked
                  THEN \* one step under the lock: no send lands between the checks and the write
                       IF After(lastActivity) \/ Busy \/ msgs # bundleMsgs
                       THEN st' = "refused" /\ UNCHANGED movedTo
                       ELSE st' = "settled" /\ movedTo' = TRUE
                  ELSE /\ st' = IF After(lastActivity) THEN "refused" ELSE "checked"
                       /\ UNCHANGED movedTo
               /\ UNCHANGED <<clock, status, msgs, edits, lastActivity, sends, ex, exportedAt, bundleMsgs, bundleEdits>>
SettleRest == /\ st = "checked" /\ st' = IF Busy THEN "refused" ELSE "rested"
              /\ UNCHANGED <<clock, status, msgs, edits, lastActivity, sends, ex, exportedAt, bundleMsgs, bundleEdits, movedTo>>
SettleWrite == /\ st = "rested" /\ st' = "settled" /\ movedTo' = TRUE
               /\ UNCHANGED <<clock, status, msgs, edits, lastActivity, sends, ex, exportedAt, bundleMsgs, bundleEdits>>

Next == Tick \/ Send \/ TurnStarts \/ TurnEnds \/ ExportCheck \/ ExportPush \/ ExportRead
        \/ ExportStamp \/ SettleCheck \/ SettleRest \/ SettleWrite

Spec == Init /\ [][Next]_vars

\* Once the copy here is settled, everything on it went in the bundle, and nothing runs on it:
\* the copy there is not behind.
NothingLeftBehind ==
    movedTo => /\ msgs = bundleMsgs /\ edits = bundleEdits /\ ~Busy
=============================================================================
