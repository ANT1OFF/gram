# Contributing

[Up: Gram](README.md) · [Docs map](docs/README.md)

Gram is built for individual developers using their own tools and accounts. Read
[AGENTS.md](AGENTS.md) for the standing rules, [development](docs/DEVELOPMENT.md) for setup and
[architecture](docs/ARCHITECTURE.md) for package boundaries.

## Changes

Follow the existing TypeScript and Effect patterns. Preserve exact dependency pins, the
workspace catalog, native overrides and the Effect patch unless the change requires otherwise.
Use synthetic fixtures; never commit real transcripts, tokens, private discussions, user
configuration or environment files.

Run `bun run check:scaffold` and the checks the change calls for, chosen from the
[verification matrix](docs/VERIFICATION.md#task-verification-matrix). `bun run check` is the
complete application check; browser and native checks have their own setup.

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

## Security-sensitive changes

Changes to the updater, release tooling, credentials, consent, approvals, the loopback server or
anything that writes to an external service get an independent review of the current head before
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

## Merging with Gram

Gram can gate its own merges on a local check of the PR's head merged onto its base. That is
opt-in per project: the project's `localCheck` settings name the setup and check commands, and
with none configured Gram relies on CI and GitHub's rules. For this repository the maintainer
configures:

- setup: `test "$(bun --version)" = "$(cat .bun-version)"`
- check: `bun install --frozen-lockfile && bun run check:ci`
- timeout: 90 minutes

The behaviour of the gate itself is in [agents and features](docs/AGENTS_AND_FEATURES.md).
