---
name: run-app
description: Start, drive and verify Gram with the repository's own commands. Use when asked to run, open or screenshot the app, to see a UI change working, to check a change beyond unit tests, or before writing a script to launch or drive the app: one of these already does it.
---

# Run and verify Gram

Use these commands; do not write your own launcher, port finder or screenshot script. Each picks
free ports and cleans up only what it started. Run from the checkout's physical root
(`pwd -P`). Which checks a task needs is in the
[verification matrix](../../../docs/VERIFICATION.md#task-verification-matrix).

## To see a UI change

- Without a server or agent: `bun run dev:mock` (Vite with `VITE_API=mock`).
- One picture of one route, headless, in a fresh browser:
  `bun run dev:preview --capture --path /settings/agents --output /tmp/<new-dir>`. The output
  directory must not exist yet. Read `initial.png`/`final.png`, the errors in `browser.jsonl` and
  the result in `preview.json`. `--account signed-out|unknown` shows the other sign-in states;
  without `--capture` it opens a browser you close yourself.
- Before/after pictures for the pull request: `bun run --filter @gram/web pr:shots --list`, then
  `--shot <name>`, `--path <route> --after-only`, or `--set tour|flows|tasks`. Images land in
  `apps/web/pr-shots/out/` (gitignored). Look at them before you claim anything; never commit them.
- Browser commands use the installed Playwright Chromium and never download one. If it is missing,
  install it as in [development](../../../docs/DEVELOPMENT.md#browser-and-native-prerequisites).

## To run the real app

- `bun run dev`: the local server and Vite with the echo fake agent. It prints a boot URL
  (`/?boot=…`); open that one, and keep it out of logs and PRs: it grants API access. Add
  `GRAM_DATA_DIR=<temp-dir>` for throwaway data, `GRAM_FAKE_AGENT=0` for the installed CLIs.
- `bun run dev:desktop`: Electron, server and Vite (`GRAM_FAKE_AGENT=1` for the echo agent).
- Ports start at 4317 (server) and 5173 (web) and move up when taken; `GRAM_PORT` and
  `GRAM_WEB_PORT` pin them.

## To check a change

- While iterating: `bun run test <file.test.ts>`, then `bun run check:affected` (static checks
  plus the Vitest projects the branch touches against `origin/main`).
- A UI flow: `bun run --filter @gram/web e2e <spec.ts> --workers=1`; `GRAM_E2E_SHOTS=1` keeps the
  spec's review screenshots. Onboarding and subscriptions: `bun run e2e:smoke`.
- Docs only: `bun run check:scaffold`, `bun run fmt:check`, `bun run check:docs`.
- Before review: `bun run check` (the full check; it waits for a machine-wide slot).
- Native sessions (Electron, no outside network), each with a new evidence directory:
  `node apps/desktop/scripts/verify-web-preview.mjs <dir>`,
  `node apps/desktop/scripts/verify-pinned-pages.mjs <dir>`,
  `node apps/desktop/scripts/verify-local-browser.mjs <dir>`,
  `node apps/desktop/scripts/verify-browser-toolkit.mjs <dir>`. A packaged build:
  `bun run --filter @gram/desktop verify:package`.

## To stop

Ctrl-C the command you started, or `bun run check:cancel` for this checkout's check. Never
`pkill -f`, `killall` or `kill $(pgrep …)`: other checkouts share the machine. Kill only the PIDs
your own command started.
