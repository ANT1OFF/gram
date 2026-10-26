# Testing and verification

[Up: development](DEVELOPMENT.md) · [Contributing](../CONTRIBUTING.md)

Select checks to resolve the changed risk. Preserve complete application and
release gates; avoid repeating passing broad suites without a new change, failure
or unresolved concern. This guide owns check selection and commands.

## Task verification matrix

Find neighboring tests with `rg --files <changed-area>` and narrow an existing
Vitest file using `-t 'regression name'` when useful. Run, read the result, fix the
demonstrated cause and rerun affected checks. Expand scope when consumers or
integration risks changed; do not weaken a failing assertion to obtain green.

| Task                   | Run and inspect                                                                                                                                                   | Completion evidence                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Docs/instructions      | `bun run check:scaffold`, `bun run fmt:check`, `bun run check:docs`; compare claims to linked source                                                              | Local links/anchors/scripts resolve; instructions retain boundaries; no full local app rerun for prose alone          |
| TS runtime/contracts   | `bun run test <changed-or-consumer.test.ts>`, `bun run check:static`, scaffold                                                                                    | Actual changed consumers pass with types/static checks; complete integration uses `bun run check`                     |
| UI                     | Relevant `bun run --filter @gram/web e2e <spec> --workers=1`; mock/server setup below; add smoke for integration risk                                             | Inspect actual screenshots/traces against expected visible state and saved/request behavior, then correct differences |
| Agent adapters/helpers | Existing `subscription-protocol.test.ts`, `speed-protocol.test.ts`, helper/consent/cancel/resume files under agents/server, run with `bun run test <file>`        | Synthetic child policy and observable behavior pass with explicit auth state; no live account probe implied           |
| Native/release         | Package inspection, native loading and isolated fake-agent smoke per [development](DEVELOPMENT.md#packaging-and-dependency-notices) and [releasing](RELEASING.md) | Actual target artifact and downloaded uploaded assets validate; source review alone is insufficient                   |

For UI screenshot review, run `bun run --filter @gram/web pr:shots --help` and
select a shot, for example `bun run --filter @gram/web pr:shots --path /settings/agents --after-only`.
Use the [PR shots helper](../apps/web/scripts/pr-shots.mjs) output or the changed
Playwright spec's screenshot/retained trace, and view the image.
A generated screenshot without inspection is not visual verification. Trivial
prose does not require screenshots. Detailed native/provider opt-ins belong in
[protocol, native and live checks](#protocol-native-and-live-checks) and formal release steps in
[releasing](RELEASING.md).

## Local checks

| Command                        | Scope                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `bun run check:scaffold`       | Known private identifiers/credential signatures, scaffold/release boundaries; required by AGENTS.md  |
| `bun run check:docs`           | Tracked authored Markdown local links/anchors, known text boundaries and documented Bun script names |
| `bun run fmt:check`            | Repository formatting                                                                                |
| `bun run lint`                 | Exact dependency pins and warning-free lint                                                          |
| `bun run typecheck`            | All TypeScript project references                                                                    |
| `bun run check:static`         | Pins/lint/format/types without Vitest                                                                |
| `bun run test <affected-file>` | Focused Vitest using the pinned Node runner                                                          |
| `bun run check:affected`       | Static stages, then only the Vitest projects the branch can affect against `origin/main`             |
| `bun run check`                | Install, scaffold, docs, release metadata, pins/lint/format/types, then all Vitest, timed by stage   |
| `bun run check:cancel`         | Stops this checkout's running check and its stages, nothing another worktree started                 |
| `bun run check:ci`             | The complete check (scaffold included), then web/desktop bundles on the same source                  |
| `bun run build`                | Standalone typecheck plus bundles                                                                    |

The docs checker covers tracked/staged files; stage new docs before checking.
Use `node tools/check-docs.mjs --self-test` when changing its parser/check policy.
It is offline and checks the authored Markdown subset, not external URL availability.
It also applies the canonical scaffold identifier/credential signatures to every
tracked Markdown file. It fails on any file under `docs/verification/` or
`docs/releases/`, since a change's results belong in its pull request body, and on a
committed image outside `apps/` and `packages/` that no tracked Markdown file links or
embeds; before and after pictures go in the pull request body. The source scaffold
checker separately validates runtime/configuration invariants. Its known identifier and
credential signatures are not a confidentiality review or a security audit.

Run scaffold for every change and affected checks during iteration. Prose-only
changes need formatting, link/command validation and source readback; a full local
application rerun adds no qualification of prose. Actual automatic required CI
still runs unchanged. Broad integrations require complete application/bundle
qualification. `build:bundles` is a lower-level step for source already typechecked,
not a way to bypass types. Run from the physical checkout directory.

`check:affected` is for iteration only: it follows the workspace dependency graph
(manifest `@gram/*` dependencies and tsconfig references), runs everything when a shared
root file or a source outside every workspace changed, and never replaces the full check.

Concurrent full checks on one machine take turns through machine-wide check slots under
`~/.cache/gram/check-slots` (`GRAM_CHECK_SLOTS`, default one per eight cores). A check
holding a slot runs Vitest with its share of the cores (`GRAM_CHECK_WORKERS` or
`--workers` overrides); one waiting names the checkouts that hold the slots. A slot whose
holder died is reclaimed. Stop a check with Ctrl-C or `bun run check:cancel` from its own
checkout, never with a `pkill -f` pattern, which also kills other worktrees' runs. `killall`
and `kill` on `pgrep` matches are out too; kill only the exact PIDs your own command started.
On CI (`CI` set) there is no slot and Vitest keeps three workers.

The root `test` script, for focused runs, caps Vitest at three workers. On constrained runners the
supported compiler command is `GOMEMLIMIT=2GiB bun run typecheck --singleThreaded`;
CI runs it before normal incremental `check:ci` on that same fresh checkout.
Do not reuse another source's cache to claim a type pass.

## Browser checks

Install Chromium/system libraries as in [development](DEVELOPMENT.md#browser-and-native-prerequisites).
From the root:

```sh
bun run e2e:smoke
bun run --filter @gram/web e2e <affected.spec.ts> --workers=1
bun run --filter @gram/web e2e
bun run e2e:real
```

`e2e:smoke` is the configured four-spec subscription/onboarding set, one worker.
CI runs the whole mock suite in three preview shards (`--shard=N/3`, one worker,
one retry); see [CI](#ci).
Mock setup builds its own `VITE_API=mock` preview into `dist-e2e`, verifies a random
run token, refuses a pinned occupied port and warms cold routes. It listens and is
reached on 127.0.0.1 only, from a port derived from the checkout's path, so worktrees
start their searches apart and none can reach another's `localhost` server on `::1`. Production bundles
cannot substitute for mock preview. Locally the default is the Vite dev server;
on CI (`CI` set) it is preview. `GRAM_E2E_SERVER=dev` or `preview` chooses either. `GRAM_E2E_SET=light` or `heavy` chooses the
configured mock spec group; unset runs all.

Real-server flows build their own web/server bundles, use temporary repos and
fake agents/`gh`, one worker and zero retries. `GRAM_REAL_E2E_SKIP_BUILD=1` is only
appropriate with verified bundles from the same unchanged source; fresh CI keeps
the default. Windows is explicitly refused by this harness. Source:
[mock configuration](../apps/web/playwright.config.ts),
[owned mock server](../apps/web/scripts/e2e-server.mjs),
[real-server setup](../apps/web/e2e-real/global-setup.ts).

### Isolated UI preview

With the installed pinned Chromium from the
[development prerequisites](DEVELOPMENT.md#browser-and-native-prerequisites), run:

```sh
bun run dev:preview
bun run dev:preview --capture --account signed-out --output /tmp/new-evidence-directory
```

The first command opens an owned browser with fresh mock storage; close it or use
Ctrl-C for cleanup. The second captures signed-out UI headlessly and exits; the
output directory must be new. No backend or agent CLI is started. It selects and
verifies its owned Vite origin, retains screenshots/console/cleanup evidence and
cleans only its owned child and temporary state. It never downloads a browser;
`--chromium /absolute/executable` selects an explicit installed one.

Inspect `initial.png`/`final.png`, relevant `browser.jsonl` errors and
`preview.json`'s account/result/cleanup before claiming the expected UI state.
`bun run dev:preview --help` lists its flags. Preview success qualifies browser mocks, not provider
entitlement, backend persistence or Electron/native acceptance.

For readiness-dependent Git services, use the existing
[fixed Tools fixture](../packages/server/src/git/test-tools.ts) with explicit
Git/Claude presence and GitHub `ready`, `signed-out` or `missing`, which tests inject in
place of `ToolsLive`. Run consumer tests with the relevant state rather than inheriting host
login.

### Performance specs

The `perf-*.spec.ts` specs in `apps/web/e2e` (mock API) and `apps/web/e2e-real` (real server)
measure cold views, transcripts, idle traffic and switching on synthetic workloads. They skip
unless the opt-in variable named in each spec's header is set, and write their results to a
temporary file. Their numbers belong to the machine and load they ran on; put them in the pull
request, not the docs.

## Protocol, native and live checks

Synthetic child-CLI tests exercise actual Claude/Codex adapters, approval/cancel,
reconnect/resume and protocol ordering without provider credentials or inference.
Fake protocol success proves adapter behavior, not subscription entitlement.
Native package inspection/smoke verifies the actual bundle separately from browser
or unit tests. Real provider turns, gateway requests, microphone/model downloads,
installation and production restart require their own authorization; leave all
live opt-ins unset in normal development/CI. Isolate packaged GUI checks as described in
[development](DEVELOPMENT.md#isolated-packaged-gui); follow [releasing](RELEASING.md) for
release artifacts.

### Synthetic subscription protocols

`packages/agents/src/subscription-protocol.test.ts` starts synthetic child CLIs through
`ClaudeHostLive` (installed Agent SDK, binary discovery, auth check, hooks and stream-json)
and `CodexHostLive` (app-server, JSON-RPC, shared-server routing and lifecycle). The invented
executable protocols under `packages/agents/fixtures/subscriptions/` use synthetic session
stores, a probe environment and temporary Git repositories/worktrees. They never use
account credentials, contact providers or substitute Gram's echo agent. Resume/fork,
model switches, approvals/rejections, cancellation, reconnect, startup/sign-out recovery
and notification ordering establish adapter behavior, not subscription access. They run
on Linux/macOS; Windows executable/shim behavior needs separate native checks.

```sh
bun run test packages/agents/src/subscription-protocol.test.ts
```

### Live subscription probes

With explicit authorization, each selected adapter makes two tiny turns through the
desktop's existing CLI login in a temporary Git repository, checking discovery, streaming
and resume. Probes deny approval requests and ask for no tools. Standard probes use the
CLI's configured connectors; `GRAM_LIVE_CONFINED=1` requires every external MCP server
to be disabled and fails closed if one remains on. Credentials are never copied into a
temporary home; the CLI may retain its own synthetic session history.

```sh
GRAM_LIVE_SUBSCRIPTIONS=claude,codex bun run test packages/agents/src/subscription.live.test.ts
GRAM_LIVE_SUBSCRIPTIONS=codex GRAM_LIVE_CONFINED=1 bun run test packages/agents/src/subscription.live.test.ts
# Separate authorization: one built-in search turn; inherits explicit CLI search policy.
GRAM_LIVE_CODEX_WEB_SEARCH=1 bun run test packages/agents/src/subscription.live.test.ts
```

`GRAM_LIVE_CLAUDE_BINARY` and `GRAM_LIVE_CODEX_BINARY` optionally select an absolute
installed executable without changing PATH, pins or managed runtimes. Record its actual
version with results. Resolve expired logins, entitlement and upstream failures locally;
never send credentials to chat. A model listing, login or successful reply does not
establish Pro/Max or ChatGPT plan tier.

### Manual provider and dictation checks

Choose checks relevant to the change, separately for Claude and Codex in a disposable
repository, with authorization for each live service or device action:

- Sign in in your terminal (`claude /login` or `codex login`), re-check in Gram without a
  gateway, verify discovery/defaults and run a short turn on another native model. Visiting
  Settings must not save an unset model default. A stale Claude login must require
  `/login`, without a retry loop.
- Require approval for a benign local command in CLI settings. Approve once and reject
  another request; execution must follow approval, and rejection must resolve the card
  without execution. Cancel during streaming and while awaiting approval; a late click
  must do nothing and a new turn must start normally. Retry a refused turn after changing
  permission mode or leaving plan mode; the change must apply to the retry.
- Use a unique synthetic conversation marker, restart Gram and verify resume remembers
  it. Reopen after child-CLI exit and check stored session identity and missing-transcript
  errors. In a Git worktree, open/fork a thread, edit a synthetic file and inspect the diff;
  check its working directory, writable roots, branch and conversation.
- Check connector restrictions with your CLI config. An excluded MCP server still enabled
  must refuse startup. Confined Codex threads disable plugins and ChatGPT apps as well as
  individual MCP servers; app policy alone does not stop the apps server. Built-in search
  keeps the configured policy, with no always-on override. User config stays unchanged.
  Never disable a confinement guard to get a pass.
- For a gateway, select it explicitly and grant helper context consent only to that
  endpoint. Remove its key and verify launch refuses; switching to a local subscription
  must use the CLI's own login.
- Enable local dictation through download/license consent. Check macOS microphone
  permission, English transcription, cancellation and draft-only insertion. Record any
  human action still needed. A synthetic 16 kHz mono PCM WAV with recorded source and
  transcript can check the packaged recognizer, but proves neither microphone capture
  nor general recognition accuracy. Never upload test audio.

Record commands, CLI versions, results and untested limits in the PR. These checks do not
prove future CLI compatibility, native writer closure across independent processes or
exhaustive security; the [Codex ownership contract](AGENTS_AND_FEATURES.md#codex-ownership-and-reopening)
and [updater limits](UPDATES.md#limits) describe their own boundaries.

## Results and CI

Put the exact commands, results and untested boundaries of a change in its pull request.
Preserve failed-before regressions and honest old-head results; a focused repair is not an
all-green combined run. Keep permission/consent, credential isolation, confinement refusal and
signing/pin assertions meaningful. Never remove an assertion simply to obtain a pass.

### CI

[check.yml](../.github/workflows/check.yml) classifies each change. Ordinary prose gets a docs
job (frozen install, `bun run check:docs` and `bun run fmt:check`); everything else gets a
bounded typecheck, `bun run check:ci` and the mock e2e suite in three shards, `e2e 1/3` to
`e2e 3/3`. A `macos` job runs `bun run check:ci` on macOS and packages the unsigned app with
`electron-builder --dir`, then checks it with `verify:package`; the e2e shards run on Linux only.
A final `qualification` job passes only when the jobs the classification needs passed on that
source. [scaffold.yml](../.github/workflows/scaffold.yml) runs the scaffold and dependency
pin checks on every change. [.gram/merge-ci.json](../.gram/merge-ci.json) declares these jobs to
Gram's merge gate; its `alwaysJobs` (the e2e shards) must pass even when a local check stands in
for the rest. Pending, skipped, cancelled, failed or stale jobs are not passing CI.
A newer push cancels a pull request's superseded runs, while every main run that starts
finishes. [cancel-closed-pr.yml](../.github/workflows/cancel-closed-pr.yml) cancels a closed pull
request's remaining runs.

The `macos` job runs on GitHub-hosted `macos-15`; every other job runs on `ubuntu-24.04-arm`.
No signing or notarization secret reaches CI: releases are signed on the publisher's Mac. Workflows keep same-repository
guards, read-only token permissions, SHA-pinned actions, download-only caches and pinned frozen
installs. They use synthetic agents; CI does not qualify x64 Linux, signed or notarized Mac
builds, Windows behaviour or paid providers. [Dependabot](../.github/dependabot.yml) proposes weekly
updates no younger than 7 days and leaves Electron and its packaging, the Effect family,
sherpa-onnx and Node type majors to deliberate bumps. CodeQL default setup scans
JavaScript/TypeScript and Actions.
