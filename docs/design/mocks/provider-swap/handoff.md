# Continue in another agent: handoff

[Mock](v1.html) · [Brief](brief.md) · [Decisions](decisions.md)

## Target

The build (cut 5 of the plan "Plan: swap a thread's provider") must match `v1.html`, approved
2026-11-11. Boards and states:

- **1 Model group** (`offered`, `running`, `signed-out`): the choices chip's popover, Model
  section open.
  - The current agent's models under its mark, then a hairline and the other agent's mark with
    its models. Each group's heading is the mark alone; its words are on hover.
  - The other agent's hover reads "Continue in Codex: new session with a handoff" (or "Continue
    in Claude Code: …"). Its models end in "…", because a pick opens the sheet and changes
    nothing by itself.
  - Greyed, the models can't be picked, and the mark's hover gives the §3.2 refusal ("Wait for
    this turn to finish, or stop it, then switch.", "Sign in to Codex in Settings → Agents.").
  - With the other harness not installed, or on Windows, the group isn't there at all.
- **2 Thread menu** (`offered`, `approval`): "Continue in Codex…" is the first item of the
  thread's "…" menu, with the `ArrowLeftRight` glyph and a separator under it. Greyed, its
  refusal shows on hover ("Answer the open approval first. It can't move to Codex.").
- **3 Sheet** (`normal`, `limit`, `worker`): the confirm sheet, titled "Continue in Codex".
  - Model (the target's mark inside the field) and Effort, which ends at High.
  - Lines, each led by a glyph whose words are on hover:
    - limit mode only, first: clock, "Claude is out of usage until 15:00, so Codex's first turn
      writes the note from the transcript and does no other work.";
    - check, what Codex gets;
    - cross, "Claude's tool output, reasoning and cache: the first reply is slower.";
    - a worker only: PR glyph, "Its PR, merge when ready and checks stay with this worker, and
      its orchestrator is told.";
    - only when the mode changes: lock in the warning colour, "Codex runs this worker in Bypass.
      Its Auto needs Codex 0.166 or newer."
  - The "Ask Claude for a handoff note first" checkbox, ticked, except in limit mode.
  - Cancel (ghost) and Continue (primary).
- **4 Divider** (`normal`, `given`, `limit`): the transcript after the switch.
  - The divider reads "Continued in Codex · GPT-6.1-Sol · 14:02". Its hover gives the previous
    agent, model and session id. Its chevron opens "What Codex was given".
  - The fold is read only: the note with who wrote it (Goal, Done, In progress, Next, Traps),
    then Gram's facts (Plan, Branch, PR, Turns).
  - Messages above the divider keep their look, and the composer's chip shows the new agent's
    mark.
  - Limit mode: Codex's first turn is the note, with a muted line above it ("Claude was out of
    usage · this turn writes the note, no work"). A queued message waits with "1 queued message
    sends when this turn ends".

## Decisions

- v1 approved as drawn (WQ58, 2026-11-11). Each group's heading is the agent's mark with its
  words on hover, and the other agent's models end in "…". The sheet's lines lead with a glyph
  whose words are on hover, with the limit line first. A worker's PR binding and the
  orchestrator's notice share one line.

## Parts

| Mock                      | Becomes                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `.pop` sections           | the choices popover's `Section` (`apps/web/src/composer/choices.tsx`); the phone's `ChoicesSheet` gets the same group (`choices-sheet.tsx`) |
| `.grp` mark heading       | a group heading in `ModelSearch`'s list: the agent mark (`agents/agent-marks.tsx`) at `size-icon-chip`, in a `Hint`                         |
| `.opt.off` rows           | `aria-disabled` options, the refusal from the server's §3.2 check as the group's hint                                                       |
| "Continue in Codex…" item | a `Menu.Item` in `thread/thread-menu.tsx`, replacing `switchOpenLabel` for every thread                                                     |
| `.sheet`                  | a `DialogShell` dialog, like `orchestration/switch-orchestrator.tsx`, with `AgentFields` limited to the target agent                        |
| `.line` glyphs            | Lucide `Check`, `X`, `Clock`, `GitPullRequest`, `Lock` at `size-icon-row`, each in a `Hint`                                                 |
| `.hand` divider           | `HandoffDivider` (`thread/orchestration-cards.tsx`) with a new `handoffLabel` for `reason: "switch"`                                        |
| "What Codex was given"    | `components/ui/collapsible` under the divider, from the stored `Handoff` (note, author, facts)                                              |
| limit-mode first turn     | an ordinary reply; the muted line above it is the handoff's own meta                                                                        |
| `.queued`                 | the composer's existing queued-message line                                                                                                 |

## Deviations allowed

- Real model names and efforts as each CLI lists them, and the platform's own select controls.
- Not allowed: words where the mock has a glyph with words on hover, or a change on pick before
  Continue.

## Gaps

- **4 Divider:** `[session id]` is the stored `previousAgentSessionId`.
- The orchestrator's sheet (cut 6) uses the same layout; its lines aren't drawn here.
