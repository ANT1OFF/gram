# Contributing

[Up: Gram](README.md) · [Docs map](docs/README.md)

Gram is built for individual developers using their own tools and accounts. Read
[AGENTS.md](AGENTS.md) for the standing rules, [development](docs/DEVELOPMENT.md) for setup and
[architecture](docs/ARCHITECTURE.md) for package boundaries. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Issues and questions

Report bugs and request features with the
[issue forms](https://github.com/ANT1OFF/gram/issues/new/choose), or from inside Gram with
**Report an issue…** in the command palette. Ask questions and talk ideas through in
[Discussions](https://github.com/ANT1OFF/gram/discussions). Report vulnerabilities privately, as
the [security policy](SECURITY.md) describes. Issues labelled
[`good first issue`](https://github.com/ANT1OFF/gram/labels/good%20first%20issue) are small and
self-contained, with pointers to the code and how to verify the change.

## Changes

Follow the existing TypeScript and Effect patterns. Preserve exact dependency pins, the
workspace catalog, native overrides and the Effect patch unless the change requires otherwise.
Use synthetic fixtures; never commit real transcripts, tokens, private discussions, user
configuration or environment files.

Run `bun run check:scaffold` and the checks the change calls for, chosen from the
[verification matrix](docs/VERIFICATION.md#task-verification-matrix). `bun run check` is the
complete application check; browser and native checks have their own setup.

## Rules live in checks

The code is what an agent reads most, so a rule works best when the code enforces it. In order of preference, a rule is:

1. **Code and architecture**: a type, an API that cannot be misused, a lint rule, an import boundary.
2. **Verification**: a test, a property, a check script an agent can run before anyone reviews.
3. **Prose**, here or in `AGENTS.md`, only for judgment calls a check cannot make.

- **Turn a correction into a check.** When a review or an agent catches a mistake that could recur, add or tighten a check instead of another sentence. When a rule in `AGENTS.md` gains a check, cut the rule down to a pointer to it.
- **A check's message names the fix.** Agents read lint and check output and act on it, so a message says the root cause, what to do instead (the helper, the file, the doc) and the escape hatch if there is one. "X is forbidden" is not enough.
- **A new rule clears its existing violations** in the same change. When there are too many, it starts with a shrink-only allowlist, as `tools/oxlint/allowlists.mjs` and the design-tokens check do, so new code cannot add any.
- **Pull weeds early.** A workaround left in the tree becomes the pattern the next agent copies. Check that a pattern is the current one before you copy it.
- **A timer is not a way to wait.** Never use `setTimeout`, `requestAnimationFrame`, `queueMicrotask` or a sleep to wait for state to settle or a test to catch up. Wait on the thing itself: a promise, an event, a locator, `expect.poll`. Timers are for real time: debounce, backoff, polling, clocks.
- **Derive in render.** A React effect talks to something outside React. A value that follows from props or state is computed while rendering, not copied into state by an effect.
- **A comment says why, never excuses a shortcut.** "For now", "workaround" and "temporary" come with a linked issue or a fix. Delete a comment the code no longer matches.
- **Prove the change by running it**: the checks the [verification matrix](docs/VERIFICATION.md#task-verification-matrix) calls for, and for behaviour, the app itself (`bun run dev:preview`, `pr:shots`).

## Pull requests

- Work on a feature branch and open a PR; never push directly to `main`.
- Use a conventional title that survives squash merging: `feat:` for features, `fix:` for
  corrections, `perf:` for performance. These drive [release-please](docs/RELEASING.md#versions).
  Documentation and maintenance use `docs:`, `refactor:` or `chore:`.
- Say in the description what changed and why, the commands you ran with their results, and
  what remains untested.
- UI changes include before and after screenshots, inspected, not just generated.
- A PR merges when its required checks pass on the exact head being merged. A pass on an older
  head does not count for a changed one.
- A PR from an outside contributor also gets an independent review of its current head before it
  merges. Changes to the merge gate, credentials, the updater, signing or release tooling get
  extra scrutiny, as [security-sensitive changes](#security-sensitive-changes) describes.

## Security-sensitive changes

Changes to the merge gate, the updater, signing, release tooling, credentials, consent,
approvals, the loopback server or anything that writes to an external service get an independent
review of the current head before
they merge. Re-review fixes that change the result. While reviewing, check at least:

- **Secrets.** Trace each secret from intake to its one consumer. Use invented values and an
  isolated config, with no fallback to the host's login. Child processes inherit no tracing or
  debug variables (`SHELLOPTS`, `BASH_ENV`, `GH_DEBUG`, `NODE_OPTIONS`, Git trace variables) and
  no unrelated tokens. Failures, logs and exceptions never quote a secret.
- **Inputs and URLs.** Prefer allowlists to denylists. Parse URLs with a real parser and compare
  scheme, exact host and path segments; reject credentials, unexpected ports, queries,
  fragments and dot segments, as written and after normalization.
- **Source provenance.** Read release inputs from the reviewed commit's objects, not the working
  tree, with replacement refs and grafts refused and inherited `GIT_*` variables stripped.
- **External writes.** Simulate a server that applies a request but loses its answer, a failure
  before it applies, and a failure during later checks. Re-read the authoritative state rather
  than assuming a transport error changed nothing. Retries reuse or refuse by verified identity
  and never duplicate a publication.
- **Regressions.** Commit each reproduction as a test that fails before the fix and passes after.

## CI

A pull request runs only the CI lanes its diff can affect: prose alone (Markdown outside `apps/`,
`packages/` and `tools/`, and `docs/`) runs only the docs, format and scaffold checks, and a test
file, an e2e spec or `apps/desktop` skips the jobs it can't reach. Workflows, root configuration
and shared package sources run everything, as every push to `main` does. The lanes and what selects
them are in [verification](docs/VERIFICATION.md#ci).

## Merging with Gram

Gram can gate its own merges on a local check of the PR's head merged onto its base. That is
opt-in per project: the project's `localCheck` settings name the setup and check commands, and
with none configured Gram relies on CI and GitHub's rules. For this repository the maintainer
configures:

- setup: `test "$(bun --version)" = "$(cat .bun-version)"`
- check: `bun install --frozen-lockfile && bun run check:ci`
- timeout: 90 minutes

The behaviour of the gate itself is in [agents and features](docs/AGENTS_AND_FEATURES.md).
