# Trust a folder once

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

A folder you add to Gram can carry its own agent settings: Claude hooks, env and allow rules in
`.claude/settings.json`, MCP servers in `.mcp.json`, Codex config in `.codex/`, and scripts with
keyboard shortcuts in `.gram/scripts.json`. Today they load on the first thread with no question,
so a cloned repository's hook runs as you before you have read it (security findings `01GWJRzF`,
`01FfvZvo`). Gram should ask once per folder whether to trust it. Johan decided (19 November
2026): once per folder, no re-ask when that config changes later.

## Who and where

Anyone adding a folder or a cloned repository, from the Add repository field in New thread or
Welcome. Also anyone who opens a thread in a folder added before this change.

## Must show

- What the folder brings, by kind and count, named from its files: hooks (with the event, e.g.
  `SessionStart`), MCP servers by name, allow rules, scripts with their shortcuts.
- The two answers: trust it (its settings and scripts load), or don't (threads run with only your
  own settings; scripts don't run by key or click).
- A folder that brings nothing: no question at all.
- Where an untrusted folder says so later, and how to trust it then.
- Someone else's PR checkout: always untrusted, never offered here (it isn't the folder's call).

## Out of scope

- Re-asking when the files change (decided against).
- Per-script approval.
- Hosted Gram and remote machines.

## Open questions

- Folders added before this ship: trusted as they are (default), so nobody's setup stops
  working. Asking again would be safer but breaks every existing project once.
- Scripts in an untrusted folder: hidden (default) or shown disabled with the reason.
