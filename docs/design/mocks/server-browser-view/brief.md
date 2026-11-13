# Watching and driving the server's browser

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

When Gram runs as a server (Docker, a remote machine), agents now browse in a headless Chromium
on that server. You can't see that page: the Preview tab in a browser tab has no pane to draw it
in, so you can't follow what the agent does, or take the page over to sign in, fix a form or show
it something, and hand it back.

## Who and where

Someone using Gram from a browser tab (or the desktop app connected to a remote Gram), in a
thread whose agent uses the `browser_*` tools. They meet it in the thread's Preview tab, the same
place the desktop app shows the agent's page.

## Must show

- The same Preview strip as today (back, reload, address, inspect, driver button, open in your
  browser), with the page below it drawn from the server's frames.
- That this page is on the server and reaches only the server's loopback: say it once, quietly.
- **Agent driving**: the live page, the agent's latest action ("Opens the Filters menu"), and
  how to take control.
- **You drive**: your clicks, typing and scrolling go to the page; the strip says you have
  control and offers Hand back. The agent's next input waits.
- **No page yet**: the agent hasn't browsed in this thread.
- **Starting**: the browser is starting on the server.
- **Couldn't start**: the server has no browser (`GRAM_HEADLESS_BROWSER` unset, or Chromium
  missing) or it stopped, with the server's message.
- **Reconnecting**: the stream dropped; the last frame stays, dimmed.

## Out of scope

- Opening sites off loopback, or your own sign-ins: the server's browser reaches loopback only.
- Copy and paste between your computer and the page, file uploads, sound.
- The desktop app's own Preview pane, which keeps drawing its native page.
- Phone layout beyond holding at 390 px.

## Open questions

- How you take control. Default: an explicit **Take control** button in the strip and on a hint
  over the page; clicking the page while the agent drives does nothing but show the hint, since a
  stray click mid-action is worse remotely than locally. A tweak shows the desktop's behaviour
  (any click or key takes over) for comparison.
- Frame rate and quality: the stream follows the page's own repaints (Chromium's screencast),
  scaled to the pane; not a design question, noted for the build.
- Whether the address strip may navigate the server's page. Default: yes, to loopback addresses
  only, with the same refusal text as the agent's tools.
