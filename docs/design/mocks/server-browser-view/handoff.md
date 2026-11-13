# Watching and driving the server's browser: handoff

## Target

`v2.html`, board **Preview tab**, in its states: agent, yours, empty, starting, failed,
reconnecting.

## Decisions

- Any click or key in the page takes control, as in the desktop app. Control returns to the agent
  after 20 s without input, or at once with Hand back.
- The first build shows only the page the agent opened: the address is shown, not typed.
- The line saying the page is on the server's browser is shown once, quietly, under the strip.

## Parts

- The strip, the agent's action line and the driver button are the Preview pane's own
  (`apps/web/src/panels/preview-pane.tsx`): `ToolButton`, `AgentActivity`, `DriverButton`.
- `.callout.danger` becomes `PanelMessage` with the pane's Retry button, as the pane's other
  failures.
- `.empty` becomes `PanelMessage` with the globe icon.
- `.over` (the hint over the page) and `.frame` (the drawn page) have no match: new, in the pane.

## Deviations allowed

- The page is drawn at its own proportions, scaled to fit, so its edges differ from the placeholder.
- The agent state's hint may fade once read.
- Not allowed: dropping a state, or taking control without the strip saying so.

## Gaps

- `[Live frames …]`, `[The same page …]`, `[The last frame, dimmed]`: the server's frames.
- `[The server's message …]`: what the browser host answered.
- The conversation column and sidebar placeholders are the app's own.
