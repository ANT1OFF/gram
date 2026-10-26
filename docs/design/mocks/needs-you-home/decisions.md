# Needs you home: decisions

One line per review round: what was asked, what changed, in which version. The mock-review skill
keeps this; the build reads it with the approved version.

- v1: three directions for review. A Inbox is a lighter list view. B Jump is a popover, a jump to
  the exact turn, and a next-needs-you stepper. C Hybrid is B's popover with quick answers plus a
  side panel behind "See all".
- v1 approved: C Hybrid, with B's jump to the exact turn and the next-needs-you stepper. A Inbox
  and B Jump are dropped.
- Build: ⌥⌘↓/⌥⌘↑ already move focus between panes, so the stepper is ⌘⇧U ("Next thread that
  needs you", item by item at its turn) and ⌘⇧Y for previous. The popover shares its six rows
  across workspaces, so each one that has something shows it. Approvals carry no time, so they
  show no age. With no pill on screen (window under the rail's width), ⌘⌥3 opens the panel.
