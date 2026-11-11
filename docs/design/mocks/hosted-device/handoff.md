# Lend this Mac to a hosted workspace: handoff

[Brief](brief.md) · [Decisions](decisions.md) · [Approved page](v1.html) ·
[Design note](../../personal-device.md)

## Target

`v1.html`, approved on 11 November 2026 with its defaults as drawn. The build must match these
boards and states:

- **1 Sign in** (signed-out, browser, new-server, signed-in): Settings → Hosted.
- **2 Lend this Mac** (off, on, refused-folder, read-only, turned-off, resume): a hosted
  workspace's page under Hosted. Its buttons only open the lending sheet; **Stop lending** acts
  at once.
- **The lending sheet** (first-time, resume): a window the main process owns.
- **3 A thread asks** (waiting, ran, refused, offline, not-yours): the hosted thread's rows and
  the sidebar's lending mark.
- **4 The ask** (plain, look-closely, hidden-characters, reading, withdrawn): a window the main
  process owns.
- **5 Activity on this Mac** (full, empty).

## Decisions

Approved as the defaults in [section 10 of the design note](../../personal-device.md#10-open-decisions):

- Nothing skips the ask: every command and every file read is asked.
- Lending turns off when Gram quits; Resume lending is confirmed in the lending sheet.
- Commands and file reads only; no agent session runs on a lent machine.
- Only the thread the person writes to can ask, not workers it spawns.
- A thread can ask for ten minutes after the person writes to it from this machine.
- Confinement by the operating system comes later, and before any rule that skips the ask.

## Parts

| Mock                               | Build                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `.hd-nav` Hosted and its sub-items | A new Settings group, shown only with hosted features on (also `e2e/settings.spec.ts`, `settings-nav.ts`) |
| `.hd-group`, `.hd-row`             | The settings page's existing group and row components                                                     |
| The new-server dialog              | A main-process dialog, not `components/ui/dialog`: accepting a server is a decision (new)                 |
| The lending sheet                  | A main-owned `BrowserWindow` with its own origin, session and preload (new)                               |
| The ask                            | A main-owned `BrowserWindow`, as above, left out of every all-windows loop (new)                          |
| `.hd-command`, `.esc`, `.nl`       | A plain-text command box that draws invisible code points as escapes (new)                                |
| "What it runs" facts               | Facts from a shell parse in the main process; never a clean state (new)                                   |
| `.hd-ws` with "hosted"             | The sidebar's workspace rows, grouped under the server's host name                                        |
| `.hd-lending`                      | A sidebar footer mark fed by the main process's lending state (new)                                       |
| `.hd-tool` rows                    | The thread's tool-call row, with the device's fixed refusal reasons as copy                               |
| Activity table                     | `components/ui/table` in a main-owned window, read from the local log                                     |

## Gaps

- The hosted view's own web contents and its reduced bridge aren't drawn: they change nothing a
  person sees.
- "This Mac" becomes "this computer" off macOS.
- The pause and lending being unavailable are drawn in [v2](v2.html) (states paused,
  no-keyring and no-lock-signal on "2 Lend this Mac", lift-pause on "The lending sheet"), awaiting
  review.
