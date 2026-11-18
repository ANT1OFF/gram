# A worker whose machine was lost: decisions

One line per review round: what was asked, what changed, in which version. The mock-review skill
keeps this; the build reads it with the approved version.

- v1 (2026-11-18): A In the conversation picked. The brief's defaults stand: the same
  conversation resumes with a note from Gram, the last save isn't shown in the header until
  something goes wrong, and the words are Gram's own ("machine").
- Build (2026-11-18), against v1 A: the card is in the turn's place in the conversation, with
  Resume worker, and the resume is the same conversation told by Gram what was cut off. Left for a
  later change: the save's time and the files it held (the card says the folder comes back as
  last saved, every few minutes while working, rather than naming 08:12 and 6 files), View diff,
  the step-by-step resuming list, and the worker's row in the orchestrator.
- Build 2 (2026-11-18), against v1 A and C: the save's time and files on the card (Saved, Lost, the
  first two files and the rest counted) and View diff, which opens the diff the machine last sent
  in the diff panel's own rows. The worker's rows (Workers, the sidebar, the failures strip) say
  "Machine lost" with what was saved, and the strip opens the worker to resume rather than retry.
  The task's card, Runheim's board 5, gets a Changes line under the worker ("+25 −21 in 6 files ·
  saved 08:12 · Diff") with Resume worker beside it once its machine is lost. Left out: the Branch
  row (whether commits were pushed isn't known without the machine) and the step-by-step resuming
  list.
