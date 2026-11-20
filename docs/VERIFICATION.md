# Testing and verification

[Up: development](DEVELOPMENT.md) · [Contributing](../CONTRIBUTING.md)

Select checks to resolve the changed risk. Preserve complete application and
release gates; avoid repeating passing broad suites without a new change, failure
or unresolved concern. This guide owns check selection and commands.

## What earns a test

A test costs every run of CI, every reader, and every intended change that has to edit it. Write one
when it guards behaviour that could plausibly break and that someone would mind: a state machine, a
parser, a refusal, a race, a recovery, a contract another part depends on, a bug that already
happened once.

Always test, and never delete to save time:

- security, auth and scope checks; policy and approval decisions; what a model may and may not do
- credential isolation and egress; untrusted input reaching a prompt (fencing, escaping)
- migrations, row-level security, and anything that can lose or corrupt data
- the API and MCP contract other code or embedders depend on; the merge and release paths
- a regression test that names the bug it pins

Don't write, and delete when you meet one:

- **Wording checks.** A test that a prompt, skill, doc, tool description or UI label contains a
  phrase fails exactly when someone edits it on purpose. Test the logic that builds the text (a
  section appears or not, data is filled in and escaped, a cap holds), not the sentence. Whether a
  prompt makes a model behave is an eval's job, not a unit test's.
- **Copy and markup pins.** Exact sentences, class names, DOM shape, uncompared screenshots,
  snapshots of copy. Assert the state, role, value or data attribute the behaviour depends on.
- **Tests that cannot fail.** Restating a constant table, checking that two values built to differ
  differ, `.catch`-ing the error you meant to require, an `expect([...]).toContain` that accepts
  either outcome.
- **Mirrors.** Mocking the unit under test, asserting call order or call counts of internals, or a
  fake that makes the decision being asserted.
- **Duplicates.** The same behaviour at two layers (keep the cheaper one that still catches the
  break), or many cases on one path with trivially different inputs (keep the boundaries, as one
  `it.each`).

Keep it cheap:

- No real sleeps. Use the test clock, fake timers, or wait on the signal itself. `gram/no-sleep`
  refuses `page.waitForTimeout` and a hand-rolled `new Promise((r) => setTimeout(r, ms))`; the
  files not moved yet keep a count each in `tools/oxlint/allowlists.mjs`, which only falls. Product
  code that does mean real time uses `setTimeout` from `node:timers/promises`, or `sleep` from
  `apps/web/src/lib/sleep.ts` in the web app.
- Expensive setup once per file (a started system, a server, a repo, a rendered chart), not once per
  case.
- Push a check to the cheapest layer that catches it: a unit or component test before an integration
  test, an integration test before a browser journey. A browser journey earns its place by a real
  flow across screens, not by checking one component.
- A slow test that guards something critical stays; make it faster, don't drop it.

When you review a test, ask: what bug would make this fail, and would anyone else notice it first?
If the answer is "someone changed the wording" or "nothing", it shouldn't be there.

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
Playwright spec's screenshot/retained trace, and view the image. Specs write their review
screenshots only when `GRAM_E2E_SHOTS` is set (to anything), since nothing compares them.
A generated screenshot without inspection is not visual verification. Trivial
prose does not require screenshots. Detailed native/provider opt-ins belong in
[protocol, native and live checks](#protocol-native-and-live-checks) and formal release steps in
[releasing](RELEASING.md).

### UI rating tour

With the installed Playwright Chromium, capture the main surfaces in realistic mock states:

```sh
bun run --filter @gram/web pr:shots --set tour
```

The tour is after-only and writes PNGs in dark and light to the gitignored
`apps/web/pr-shots/out/`, with an ordered `tour.md` index explaining each frame. Frames are
1728 × 1095 CSS px at 2×, the size of a real window; `--size 1440x900` captures the older size.
They show the realistic mock scenario (`apps/web/src/api/mock-realistic.ts`): four orchestrators,
a few live workers, merged work and one ask, as a working day looks. Frames named `stress-` stage
the fixture scenes that pile every state on at once; they test layout, not the normal view.
Every run replaces that output directory. `--set tour --list` lists the frames;
`--set tour --shot 03-board --mode dark` captures one for iteration. The source list is
[tour.ts](../apps/web/pr-shots/tour.ts). Read the index in order and inspect every frame for
loading states or missing content. These are synthetic UI scenarios, not live-provider evidence.
The tour changes no product screens. Do not commit the images; attach selected frames to a PR
body using relative Markdown image links and, from the output directory:

```sh
gh pr edit <pr> --body-file <body.md> --attach ./02-orchestrator-dark.png --attach ./03-board-light.png </dev/null
```

### Reaching a feature by name

```sh
bun run drive --list
bun run drive memory board --no-shot
bun run drive --all
```

`docs/features.json` gives each feature with a screen a `ui` block: `where` says in the app's
words where a person finds it, and `route`, `steps` and `landmark` say how a driver gets there
(roles, labels and test ids, never CSS). `bun run drive <feature>` starts the mock UI on the
realistic scenario, reaches each named feature in a fresh browser and writes `<slug>.aria.yml`
(the feature's accessibility tree, a few KB: read it before any picture), `<slug>.png`, and with
`--video` `<slug>.webm`, plus `browser.jsonl` with the page's errors. It writes them to
`GRAM_VERIFY_EVIDENCE_DIR` with a `manifest.json` when a [verify driver](AGENTS_AND_FEATURES.md#verify-recipes)
runs it, otherwise to a new folder under `apps/web/drive-out/` (gitignored). `--all` exits 1
when a feature is not where the map says. When a change moves a control a `ui` block names,
update the block in the same change: `tools/feature-map/check.mjs` fails on a test id the source
no longer has, and `apps/web/e2e/feature-map.spec.ts` fails when a landmark doesn't show.

For live clicking, run `bun run dev:preview` for a disposable Chromium window with fresh mock
storage (see [isolated preview](#isolated-ui-preview)). Or run `bun run dev:mock`, open Gram's
right panel → Preview, and enter the local Vite URL printed in the terminal. Both use the mock
API without a backend or agent CLI. The seeded solo threads already contain transcripts, diffs,
questions and an approval; use the sidebar, Board/Chat switcher, the Inbox, the Workers tab (⌘J, Ctrl+J on
Linux/Windows), History (⌘⇧H), ⌘K and Settings to explore.

To populate an orchestrator workspace in the mock browser, run
`sessionStorage.setItem("gram.mock.orchestration", "realistic")` and reload for the realistic
scenario, or run `await window.gramMock.simulateOneThread()` in its developer console, then click the new
`agent-platform` workspace in the sidebar. For Focus's busy workspace, run
`await window.gramMock.simulateQuietBusy()`, click `casefiles`, then Focus under View in the title
bar's … menu. Memory in an orchestrator's header opens the seeded memory files and memory updates. Navigate by clicking after
seeding: mock workspaces live in memory and a page reload drops them. Start a fresh preview to
reset the scenarios; close its browser or press Ctrl-C to clean up its owned resources.

`bun run --filter @gram/web pr:shots --set flows` exercises common interaction paths and
captures their key steps in `out/flows/`, with its own index. It defaults to dark;
`--mode light` selects light. Run it after the tour to retain both sets (a full tour run
replaces all of `out/`). The flow shots verify mock actions such as saving settings, stopping
a turn and retrying an error; they do not qualify native or provider behavior.

### Scripted rating tasks

```sh
bun run --filter @gram/web pr:shots --set tasks
```

This contributor-only set drives 12 rubric tasks through visible roles, labels and keyboard
shortcuts over the realistic mock. It writes `tasks.json`, `tasks.md`, one WebM per task and
key-frame PNGs to gitignored `apps/web/pr-shots/out/tasks/`. Do not commit recordings or images.
It defaults to dark; `--mode light`, `--size 1440x900`, `--list` and `--shot 11-stop` work here too.
A tasks run replaces only `out/tasks/`; a full tour replaces all of `out/`.

Each task declares its start and goal. Fixture staging and initial navigation are outside the
measurement; measured actions never call mock controls or navigate by URL. One click, keyboard
chord or contiguous text entry counts as one step; focusing an input counts as a click unless it
already has focus. Reports retain attempted actions, completion checks, dead ends and frames.
An unexpected failure exits nonzero and stays failed, rather than becoming “not possible”.
The JSON includes the app's Git revision, capture date, viewport and per-task theme. Elapsed time
excludes setup and PNG capture overhead, includes UI waits, and measures automation, not human
speed or live-provider latency. Videos include the brief setup; `taskStartVideoMs` is the
approximate measured start offset. A reload used to verify settings persistence is an assertion,
not a counted task step. The chosen tasks include a diff, an approval and an effort change;
they do not claim to qualify every alternative in those rubric categories.

To drive a separate installed checkout of main with this worktree's runner, set
`GRAM_PR_SHOTS_WEB_DIR` to that checkout's `apps/web` directory. Keep its pinned dependencies
installed. The report records that checkout's revision; no source files are copied into it.
Inspect every task's start/final frames and recording before giving the evidence to raters.
These synthetic runs qualify browser UI paths only.

## Local checks

| Command                        | Scope                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `bun run check:scaffold`       | Known private identifiers/credential signatures, scaffold/release boundaries; required by AGENTS.md  |
| `bun run check:docs`           | Tracked authored Markdown local links/anchors, known text boundaries and documented Bun script names |
| `bun run fmt:check`            | Repository formatting                                                                                |
| `bun run lint`                 | Exact dependency pins, the design-token drift check and warning-free lint                            |
| `bun run typecheck`            | All TypeScript project references                                                                    |
| `bun run check:static`         | Pins/lint/format/types without Vitest                                                                |
| `bun run test <affected-file>` | Focused Vitest using the pinned Node runner                                                          |
| `bun run check:affected`       | Static stages, then only the Vitest projects the branch can affect against `origin/main`             |
| `bun run check`                | Install, scaffold, docs, release metadata, pins/lint/format/types, then all Vitest, timed by stage   |
| `bun run check:cancel`         | Stops this checkout's running check and its stages, nothing another worktree started                 |
| `bun run check:ci`             | The complete check (scaffold included), then web/desktop bundles on the same source                  |
| `bun run build`                | Standalone typecheck plus bundles                                                                    |

Gram's own [verify recipe](AGENTS_AND_FEATURES.md#verify-recipes), `.gram/verify.json`, names the
same checks as drivers an agent runs with `verify`: `static` for every change, and the Vitest
projects (`contracts`, `server`, `web`, `shell`) for the paths they cover. Each starts with
`bun install --frozen-lockfile`, since Gram runs it in a fresh worktree of the commit. `bun run check`
stays the merge gate.

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
`bun run --filter @gram/web e2e:embed` is a run of its own for the
[embeddable package](EMBEDDED_WEB_APP.md#checking-it): it builds the package and a separate
app that mounts it; CI runs it in the first e2e shard.
CI runs the whole mock suite in eight preview shards (`--shard=N/8`, one worker,
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

### Property-based UI tests

A scripted spec checks the sequence someone wrote down; a property-based one has
[fast-check](https://fast-check.dev/) make random sequences of what a person does, runs each on a
fresh mock, and checks a model after every step. It earns its place by what only the page can get
wrong: views that read one list and must agree, controls enabled exactly when they act, no
`undefined` on screen, nothing thrown. Rules below the page (a store, a reducer, a derived list)
belong in a unit test.

[`needs-you-properties.spec.ts`](../apps/web/e2e/needs-you-properties.spec.ts) is the first: allow,
deny, plans, answers, Undo, the undo window passing, Open thread and a workspace's Board, with the
sidebar, the window title, the Inbox and the Board's chip held to the model's count. It pauses the
page clock and moves it only in its own ticks, so a seed replays the same steps. It runs in the
mock e2e lane with a fixed seed and a few runs. A failure prints the shortest sequence that breaks
it and a replay line:

```sh
GRAM_UI_PROPERTY_SEED=<seed> GRAM_UI_PROPERTY_PATH=<path> \
  bun run --filter @gram/web e2e needs-you-properties.spec.ts --workers=1
```

`GRAM_UI_PROPERTY_RUNS` and `GRAM_UI_PROPERTY_STEPS` try more and longer sequences, and a new seed
tries others; do that when changing what needs you. Unlike the
[random exploration trial](#random-exploration-trial), it explores only the steps it lists, and
replays them, so it can gate a pull request.

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

`apps/web/e2e-real/perf-headline.spec.ts` is the short list to compare before and after a change:
opening and paging a 41,000-item thread, sending to a 75,000-item one, a phone's first launch in
bytes and over slow 3G (with the data it uses and the files the first sight of the thread waited for), a phone's reconnect and a terminal attach over slow 3G. It also times a reply's first words
and the frames while a long reply streams (the echo agent's `/stream{N}`), frames and memory while
scrolling the long thread, an approval reaching Needs you and its answer reaching the agent, a
coding worker's start to its first output, and how soon a phone is back in touch after the network
drops and returns. It writes JSON, and
`tools/perf/headline-chart.mjs` turns two runs into a table and a chart:

```sh
cd apps/web
GRAM_PERF_HEADLINE=1 GRAM_PERF_OUT=/tmp/before.json \
  bunx playwright test --config e2e-real/playwright.config.ts perf-headline --trace off   # on main
GRAM_PERF_HEADLINE=1 GRAM_PERF_OUT=/tmp/after.json \
  bunx playwright test --config e2e-real/playwright.config.ts perf-headline --trace off   # on the branch
node ../../tools/perf/headline-chart.mjs /tmp/before.json /tmp/after.json --out /tmp/perf.svg
```

Run both sides on the same idle machine. `GRAM_PERF_SCALE=0.02` is a quick functional run of the
spec itself, not evidence. Each scenario's `detail` names the largest files and socket answers, which
is where to look first when a number is high.

The web build fails when the first paint, a lazily loaded chunk or a route's own load grows past
its budget in `apps/web/bundle-budgets.json`; `GRAM_BUNDLE_REPORT=1 bunx vite build` prints every
route's size. Raise a budget in the pull request that means the growth.

`tools/perf/ci-flake-rate.mjs` reads GitHub's listing of the trunk's check runs and says how many
went red, which on a trunk of reviewed commits is mostly tests that fail some of the time.

On CI, a Vitest shard that fails in at most five files runs those files once more, alone
(`tools/check/rerun.mjs`). If they pass, the shard passes and each test that failed first is named
as a "Flaky test" warning on its file and in the job's summary: a flake then costs a rerun of its
file instead of the shard, and stays listed until it is fixed. More failed files is a break and
fails at once. A local check, and the local checks a merge accepts, never rerun.
`GRAM_CHECK_RERUN=0` turns it off. The e2e shards' Playwright already retries a failed test once
and reports it as flaky.

### Random exploration (trial)

[Bombadil](https://github.com/antithesishq/bombadil) clicks, types, scrolls and navigates the mock
app at random and checks the properties in [spec.ts](../apps/web/bombadil/spec.ts) on every state
it captures: its own (no console errors, HTTP errors, uncaught exceptions or unhandled
rejections), the Inbox count agreeing with its rows, no click adding two history entries, Back
leaving the page it started from, and no `undefined`, `NaN` or `[object Object]` outside code.
Further properties check that nothing says "Loading…" or stays `aria-busy` for more than 10 s, that
at 360, 768, 1024 and 1440 px wide (it resizes the window now and then) the page never scrolls
sideways and no titlebar or dock controls overlap for a second, that Escape closes the topmost
dialog or menu and returns focus to its opener, and that no list shows one item's row twice. It
serves the e2e preview bundle on 127.0.0.1 with synthetic mock state, in Playwright's Chromium,
with coverage instrumentation off (with it on, the app never renders). From the root:

```sh
bun run --filter @gram/web bombadil -- --time-limit 90s
```

It exits 0 when the time runs out with every property holding, 2 on a violation and 1 on an
error, and stops at the first violation unless given `--keep-going`. The log, the trace and the
violation's text go to `apps/web/bombadil-out/`; `--help` lists the flags. A run takes its own
path each time and its replay diverges, so a trace is a trail of screenshots and values to read,
not a reproduction.

`noFlicker` counts what the app does on its own, with no input since: an element gone for a frame
and back within 300 ms, text going A → B → A, a list emptied and refilled, and a layout shift. The
recorder is [flicker-observer.ts](../apps/web/e2e/flicker-observer.ts), self-contained so that a
Playwright spec can install it with `page.addInitScript(installFlickerObserver)`. The spec lists
the flickers it allows: intended ones, such as a cross-fade, and known ones the trial found and
nobody has fixed, each with its reason. They still show in the trace's `flicker.allowed`. Remove a
known entry with its fix.

[bombadil.yml](../.github/workflows/bombadil.yml) runs it for ten minutes nightly and by hand,
writes a violation to the job summary and uploads its trace. **It is not a gate**: it never runs
on a pull request and is in no lane, required check or `merge-ci.json`. The four-week trial is
reviewed around 2026-12-18 for real bugs found, false positives, upgrade churn and whether
instrumentation works upstream. Pin upgrades are deliberate: each 0.x release can break the spec
language and the trace format.

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

### Preview web session

`apps/desktop/scripts/verify-web-preview.mjs` runs the installed pinned Electron in an owned
temporary profile with the real preview module and no outside network. The web session's lookup
answers for synthetic names (public, rebound, alternating, failing, empty), its proxy's dial
connects the public answer to the fixture's own listener, Chromium's resolver maps every name to
loopback and an owned HTTP proxy stands as the system's, so a connection around the session's
proxy would be seen. It checks that a remote page loads in a session apart from the app's and the
agents', gets no Gram cookie, bridge or Node, and reaches nothing on loopback or a private network
by fetch, socket, script, redirect, rebound or failing lookup, or WebRTC STUN and TURN over TCP to
loopback or a private address (with a control session showing the same probe does reach them),
even with the user's private page open at that very address in another thread; that a private
page loads in its own session, where its public frame doesn't load, its link to the internet opens
in the shared session, and an opaque sandboxed child (`data:` and `srcdoc`) that runs has its fetch
and its TURN over TCP to a second private address refused; that the system proxy is never used, and the session's own
answers no other process without its credential; that permissions and downloads are refused; that
a local page's link, script or redirect (an agent's, as `show_panel` opens it) goes to the link
question and never into the web session; that the loopback open channel refuses a web page and
the web one loopback; that the user's web page closed for newer threads' re-opens once by its
token, at the shell's record, while one an agent's page replaced never does; and that an agent
never gets the user's web page. It proves
the session rules, not a real site's behaviour. A `<link rel=preconnect>` doesn't fire in this
fixture, even without the proxy, so it isn't checked natively; the proxy's unit tests cover the
rule it would meet.

```sh
node apps/desktop/scripts/verify-web-preview.mjs /tmp/new-evidence-directory
```

### Pinned pages session

`apps/desktop/scripts/verify-pinned-pages.mjs` runs the installed pinned Electron in an owned
temporary profile with no outside network. It pins a synthetic worktree's page with the server's
own pages store, serves it with the server's own listener code, and opens it through the shell's
pages module in the real `gram-pages` session, with the page guard preload built as the app builds
it. It checks that the pinned copy loads, not the worktree's later edit; that the shell opens only
the announced listener origin; that the page runs at an opaque origin and loads its own files,
module script included; that no fetch, socket, beacon, event stream, WebRTC STUN or TURN, popup,
form, dialog, storage, cookie, download, bridge or app IPC gets out, to Gram's server, a name,
another pinned page or the internet; that it can't navigate away; that script copies (named by a
string, an object, a boxed string or a name that changes), the copy event and the async clipboard
leave the clipboard as it was while the user's own copy still works; that a page that replaces its
document after parsing (`document.open`, a `document.write` that opens it, a `javascript:` URL)
can't change what the user copies; that the Preview tab's local session refuses its URL; and that
with the listener's headers gone the session alone still holds. A control session without the
policy or the guard shows each probe reaches what it looks for. A `<link rel=preconnect>` fires in
no session of this Electron, a control's included, so it isn't checked natively. The keyboard's
copy leaves the clipboard alone even in the control here, so the edit menu's Copy is the user's
copy the checks rely on. On Linux it needs a display (`DISPLAY`), which is all of the environment
it passes on.

```sh
node apps/desktop/scripts/verify-pinned-pages.mjs /tmp/new-evidence-directory
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
  permission (on Linux, capture from the sound server's default input, with no permission
  prompt), English transcription, cancellation and draft-only insertion. With Keep
  microphone ready on, check the indicator stays lit, then goes out 2 minutes after the last
  focus or dictation, and at once when it's turned off. Record any
  human action still needed. A synthetic 16 kHz mono PCM WAV with recorded source and
  transcript can check the packaged recognizer, but proves neither microphone capture
  nor general recognition accuracy. Never upload test audio. For Accurate mode, check that
  each pause replaces the live words with punctuated text and that a pause with no speech
  adds nothing; `apps/desktop/src/speech.live.test.ts` runs the same pass on a WAV with
  `GRAM_LIVE_SPEECH_ACCURATE` (an unpacked Parakeet export) and `GRAM_LIVE_SPEECH_VAD`.

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

[check.yml](../.github/workflows/check.yml) classifies each pull request by its diff against the
actual base ([ci-policy.ts](../packages/git/src/ci-policy.ts)) and runs only the lanes it can
affect, into `main` or an integration branch. A merge is not checked again on `main`. Only two kinds of run happen
there, each with every lane: a release commit's (`chore(main): release …`), which a release takes
as its evidence, and a manual run. The macOS jobs start once `check static` has passed. Classification runs from the event's merge
commit, the source the jobs' conditions come from, and falls back to every lane on any other
checkout, so a branch's own copy of the classifier never picks its lanes. Prose (Markdown outside `apps/`, `packages/`
and `tools/`, and everything under `docs/`, but the mock files and the mock-build skill that tests read) gets a docs job: frozen
install, `bun run check:docs` and `bun run fmt:check`. Everything else runs `check static` (a
bounded typecheck, the check's static stages via `node tools/check/run.mjs --only static`, and the
bundle build) and whichever of these lanes its paths reach:

| Lane      | Jobs                                                                                                                         | Skipped when the change only touches                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `tests`   | `check tests 1/2`–`2/2`, `macos tests 1/3`–`3/3` (Vitest)                                                                    | prose: tests read sources as text, e2e specs included      |
| `package` | `macos package` (bundles, `electron-builder --dir`, `verify:package`), `linux package` (AppImage, .deb, installs, `--smoke`) | test files, release and repository tools, e2e specs, mocks |
| `e2e`     | `e2e 1/8`–`8/8` (mock-API Playwright, Linux only)                                                                            | test files, `apps/desktop`, release and repository tools   |

Every other path, including workflows, `.gram/`, root configuration, the lockfile and any shared
package source, runs every lane. The e2e suite reaches every workspace but `apps/desktop`, and
[ci-lanes.test.mjs](../tools/check/ci-lanes.test.mjs) keeps the table true to the workspace graph.
Gram's local check still runs the whole `check:ci` in one place.
A final `qualification` job passes only when every selected lane's jobs passed and every other
job was skipped.
[scaffold.yml](../.github/workflows/scaffold.yml) runs the scaffold and dependency
pin checks on every change. [.gram/merge-ci.json](../.gram/merge-ci.json) declares these jobs to
Gram's merge gate; its `laneJobs` map each lane to its jobs, so the gate, which reproduces the
lanes from the diff itself, needs none of a lane it finds unaffected, and its `alwaysJobs` (the e2e
shards) must pass, or be skipped in a successful run, even when a local check stands in for the
rest. Pending, skipped, cancelled, failed or stale jobs are not passing CI.
A newer push cancels a pull request's superseded runs, while every main run that starts
finishes. [cancel-closed-pr.yml](../.github/workflows/cancel-closed-pr.yml) cancels a closed pull
request's remaining runs.

The `macos` jobs run on GitHub-hosted `macos-15`; every other job runs on `ubuntu-24.04-arm`.
No signing or notarization secret reaches CI: releases are signed on the publisher's Mac.
[release-linux.yml](../.github/workflows/release-linux.yml) builds a stable release's Linux files
on `ubuntu-24.04` with a read-only token; only its `attest` job, which runs no repository code,
holds `id-token` and `attestations` write, and nothing in it writes to a release. Workflows keep same-repository
guards, read-only token permissions, SHA-pinned actions, download-only caches and pinned frozen
installs. They use synthetic agents; CI does not qualify x64 Linux, signed or notarized Mac
builds, Windows behaviour or paid providers. `bun install` refuses to resolve a release younger than
a day (`minimumReleaseAge` in `bunfig.toml`); frozen installs take what `bun.lock` records without
that check. [Dependabot](../.github/dependabot.yml) proposes weekly
updates no younger than 7 days and leaves Electron and its packaging, the Effect family,
sherpa-onnx and Node type majors to deliberate bumps. Its security updates arrive through
`npm_and_yarn` with only `package.json` changed, because GitHub has no Bun security updates;
update the matching `bun.lock` entry before the local check can pass. CodeQL default setup scans
JavaScript/TypeScript and Actions.
