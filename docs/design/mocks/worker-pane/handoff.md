# Worker pane: handoff

## Target

`v2.html`, board **A+ Switcher and hand-over** (`#a-switcher-and-hand-over`) and its narrow board:
the states list, worker, switcher, changes, no-pr, done, back and pane-closed; narrow list, worker
and switcher. The other directions (A, B, C) are not built.

## Decisions

- One worker row at two widths: the sidebar's row, wide in the pane. Last-active age in both
  lists; started on the hover card. Running workers say what they are doing in both.
- The pane's list: "Workers N · M done", search, filter, "Orchestrator ▾" (the orchestrator's own
  views, only on the list) and ✕. Groups Needs you, Running, Waiting, Stopped, Done (folded).
- An open worker: "‹ Workers › title ▾", ↑ ↓, ↗ (open in the main view), ✕; one state line with the
  agent and age kept together; one tool row (Conversation, Changes, PR, Terminal, Files).
- Back by ‹, the crumb or Esc restores the list's groups, scroll and focus; the worker stays
  current (fill and edge), apart from the focus ring. Current clears when the pane closes.
- The sidebar folds the workers to "N in Workers ›" while the pane shows them, keeping a worker
  that needs you as a row under it; the fold line takes the keys into the pane.
- The rest of round 2's must-fix lists, as the build's pull request lists them.

## Parts

| Mock                            | Code                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| worker row, both widths         | `apps/web/src/orchestration/worker-row.tsx` (`WorkerRow`, `wide`)    |
| list head, groups               | `workers-panel.tsx` (`WorkersPanel`), `workers-group.tsx`            |
| `.menu` Orchestrator ▾, filter  | `@base-ui/react/menu` as `workers-panel.tsx` uses it                 |
| worker head, tool row, switcher | `worker-pane.tsx` (`WorkerPane`, `ToolRow`, `Switcher`, a `Popover`) |
| `title=` hints                  | `components/hint.tsx`                                                |
| steer composer and its note     | `ThreadView` `beside` with `takeoverNoted`                           |
| hand-over                       | `overview-sidebar.tsx` (`WorkspaceRow`, `handedOverItems`)           |
| plan steps (new)                | `PlanSteps` in `worker-row-wide.tsx`                                 |
| doc chips (new)                 | `WideFoot` in `worker-row-wide.tsx`                                  |

## Deviations allowed

Real data lengths and the platform's own controls. Not the structure, the hierarchy or the states.

## Gaps

None bracketed. The no-remote case has no frame; the build disables Changes and PR on a worker
outside a repository with a reason, the same pattern.
