# Needs you home

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

In the user's words: "I don't like the way it currently works. Give needs-you stuff a home, or
make it so that I can easily get to the relevant thread that has a needs-you thing."

The sidebar pill "N need you" and ⌘⌥3 opened the Board of the first workspace with an ask or a
failure, so:

- reaching the thread that owns an item took two to four clicks, and the pill never said what it
  would open;
- failing CI on an archived worker, workspace questions and waits set "for the user" had no
  obvious owner;
- waits and failures could not be answered in place, and opening a thread landed on its tail,
  not on the turn that asked;
- items in other workspaces stayed invisible until you switched workspace.

## Who and where

A solo developer running orchestrators in two or more workspaces, from the overview sidebar's
pill, ⌘⌥3, a notification, or a thread or feature card's needs-you mark.

## Must show

Per direction:

- The pill, and what it opens.
- 4 to 6 mixed items across Gram and Arb bot:
  - an approval;
  - a worker question;
  - an orchestrator question;
  - a draft wait;
  - a review wait;
  - unowned failing CI.
- Each item's kind, thread, workspace and age, with 24-hour times.
- The empty state.

Dark and light come from the bar's theme switch; screenshots in the PR show both.

## Out of scope

- The ask stack's answering controls. Each direction reuses them as they are.
- Notifications and the dock badge.
- The compact rail.
- Snooze's storage (`settings.inbox.snoozed`).
- Product code.

## Open questions

These are assumptions, each with the default picked:

- **Snooze:** kept as a one-hour "Later" in the list. Default: an icon with hover text, not a tab.
- **Grouping:** by workspace, then orchestrator. Sidebar orchestrator rows can collapse and expand
  (another worker is building that).
- **Jump target:** a thread scrolled to the turn that asked, with that turn outlined briefly.
  Default: yes, in every direction.
- **Next needs-you shortcut:** `⌥⌘↓` cycles in age order across workspaces, and `⌥⌘↑` goes back.
  ⌘⌥3 is unchanged. These keys are placeholders until checked against `keyboard/catalog.ts`.
