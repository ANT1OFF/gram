# Releasing Gram

[Up: docs map](README.md) · [Updates](UPDATES.md)

Releases, the update feed and issues all live in `ANT1OFF/gram`. A release is built and signed
once on an Apple silicon Mac, with its Linux x64 files built on GitHub from the same commit, then
goes through separate runs, each checked before the next:

1. a draft;
2. its fresh-download validation;
3. a read-only update check;
4. publication.

Merging code changes no installed app. An install changes only when its user updates it from a
published release.

One release carries both platforms; [Linux files](#linux-files) covers how its AppImage and
.deb are built and checked. They can't follow the Mac files later: the repository has immutable
releases, so a published release takes no new asset, and gram-host's installer and in-app update
download `gram_<version>_x86_64.AppImage` from that version's own release and check it against its
`SHA256SUMS.txt`. A Linux build that fails doesn't cost the Mac build, though: the draft keeps the
signed Mac files and [`release:stable linux`](#1b-linux-files-later-releasestable-linux) adds the
Linux ones before validation.

## Versions

[Release-please](https://github.com/googleapis/release-please)
([release-please.yml](../.github/workflows/release-please.yml)) keeps a draft metadata PR on
`main` with the changelog, the root and desktop package versions and
`.release-please-manifest.json`. It leaves `bun.lock` alone: Dependabot reads that file as YAML,
so it carries no annotation, and Bun's frozen install ignores the desktop version recorded there.
Its baseline is the latest release's tag; no `bootstrap-sha` pins history to a commit.
Conventional squash titles decide the next
version: `fix:` proposes a patch, `feat:` a minor, and `docs:`, `refactor:` and `chore:` add no
entry. Merging that PR publishes nothing: `skip-github-release` is on, and no tag or release is
made.

After the release below is published, the publisher swaps the merged metadata PR's
`autorelease: pending` label for `autorelease: tagged`, so the next run proposes the following
version. Never clear the label for a version that did not ship.

### Release app

GitHub holds `pull_request` runs for approval on a PR that `GITHUB_TOKEN` opened or pushed. So
release-please writes with a token from a GitHub App that only this repository installs, minted
for the one run and revoked after it. The app's key and ID live in the `release-please`
environment, whose deployment branches are limited to `main`, so no other branch's workflow can
read them. Without the app's variable it falls back to `GITHUB_TOKEN`, and each push to the
metadata PR then waits for **Approve workflows to run**.

To set it up once, as the repository owner:

1. Under your account's **Settings → Developer settings → GitHub Apps → New GitHub App**, give
   it a unique name and the repository's URL as its homepage, and clear **Webhook → Active**.
   Set **Repository permissions** to **Contents: Read and write** and **Pull requests: Read and
   write**, leave everything else at **No access**, and choose **Only on this account**.
2. Copy the **Client ID** from the app's page, then **Generate a private key**.
3. Choose **Install App** and install it with **Only select repositories** set to
   `ANT1OFF/gram`.
4. Store the key, then the ID, in the environment, and delete the downloaded key file:

   ```sh
   gh secret set RELEASE_PLEASE_APP_PRIVATE_KEY --repo ANT1OFF/gram --env release-please < <downloaded-key>.pem
   gh variable set RELEASE_PLEASE_APP_CLIENT_ID --repo ANT1OFF/gram --env release-please --body <client-id>
   ```

5. Run `gh workflow run release-please.yml --repo ANT1OFF/gram` and check that its `app-token`
   step ran. Release-please pushes only when the proposal changes, so runs already held on the
   open metadata PR still need one approval; from the next `feat:` or `fix:` on, its checks
   start on their own.

`node tools/check-release-please.mjs` checks the configuration offline. The upstream dry-run
harness, `node tools/test-release-please.mjs <action-source>`, needs the pinned action's source
installed in a temporary directory with `npm ci --ignore-scripts --omit=dev`.

## Before you start

- **Access:** your own `gh` login with write access to `ANT1OFF/gram`. No other token is
  involved, and no call inherits `GH_TOKEN`, tracing or debug variables.
- **Signing:** the Developer ID identity and the `gram-notary` notarytool profile in your
  keychain (see [Developer ID signing](UPDATES.md#developer-id-signing)). Every release
  is Developer ID signed, notarized and stapled; there is no unsigned stable path.
- **Source:** the release PR is merged, all three version fields read the version, the exact
  merged source has passed its checks, and nobody else is cutting this version.

### Holding main during the cut

The Linux workflow builds only when `main`'s head is the release commit (see
[Linux files](#linux-files)), so nothing may merge to `main` from the release PR's merge until the
Linux run is dispatched, which `release:rc` does within its first minute. After that, `main` can
move: a failed Linux run is rerun (`gh run rerun --failed`), which keeps its commit, and a
`release:rc` retry adopts the same run with `--linux-run <id>`. When Gram cuts the release, the
thread that cuts it holds `main` itself with a merge freeze instead of asking the orchestrator to
keep merges back:

1. Just before merging the release PR, freeze main and let that PR through: `merge_freeze` with
   `repo: "ANT1OFF/gram"`, `reason: "release <version> cut"` and `allow: [<release PR number>]`.
   Only the PRs in `allow` may still merge, so the cutting thread's own `merge_when_ready` (or
   `set_auto_merge`) on the release PR goes through and nothing else does. It lasts at most 60
   minutes; call it again to renew it while the cut is still before the dispatch.
2. Merge the release PR, then run `release:rc --stable`.
3. Once `release:rc` prints `linux build dispatched`, lift it: `merge_freeze` with `lift: true`.
   The rest of the cut doesn't need `main` held, retries included. Only a new dispatch
   (`release:stable linux --dispatch`) needs `main` at the release commit again.

While it stands, every other `merge_when_ready` onto `main` waits, and the ledger shows the reason
as `main is frozen by "<thread>" for release <version> cut until HH:MMZ (except #N)`. GitHub
auto-merge armed on Gram's threads' PRs into `main` is turned off when the freeze starts and armed
again, with the same method, when it ends; the freeze's result lists the PRs it took down and any
it couldn't. Workers whose work must land after the cut can wait on `schedule_wake` with
`condition: { kind: "freezeLifted", repo: "ANT1OFF/gram" }`.

The freeze doesn't cover a person merging by hand, auto-merge armed on a PR no Gram thread has, or
an entry already in a merge queue, so tell anyone merging by hand. It ends at its expiry even if
the cutting thread stops, and the orchestrator can lift it early.

## 1. Build and draft: `bun run release:rc --stable <version>`

From a clean checkout of `origin/main`, with the pinned Bun and Node:

```sh
bun run release:rc --stable 1.0.1 --work /tmp/rel-1.0.1
bun run release:rc --stable 1.0.0 --first-release --work /tmp/rel-1.0.0  # a new repository
```

A release normally updates from the repository's current `releases/latest`. A repository's first
release has none: `--first-release` takes it only into a repository with no release and no tag,
and its update checks run as an install older than any (`0.0.0`). Both refuse a repository that
answers under another name, as a renamed one does through GitHub's redirect.

It runs the check once, builds and packages once, signs every nested binary with the
hardened runtime, notarizes and staples, then checks `codesign --verify --deep --strict`,
`stapler validate`, Gram's designated requirement and `spctl`. It inspects the package, loads the
speech and PTY natives and runs the packaged `--smoke` with fake agents. Check, build and smoke
run with a temporary HOME, temporary stores and stub `claude`, `codex` and `gh`.

**The check.** Install, scaffold, docs, release metadata and the static stages always run here
(seconds). The Vitest suite, six to eleven minutes on a shared Mac, comes from `main`'s own push
run of [check.yml](../.github/workflows/check.yml) on the exact release commit, which ran it on
Linux and on macOS (`--check auto`, the default; [ci-check.mjs](../tools/release-rc/ci-check.mjs)):

- The run is looked up before the build. One that already failed stops the cut; with none at that
  commit, or when GitHub can't be asked, the whole check runs here as before.
- The build, signing and notarization go on while that run finishes. Before anything is written
  to GitHub, the run must have concluded success with every job succeeded, e2e and packaging
  included. Only the docs-only lane, which a push never selects, may skip. `check static` and
  every shard of `check tests` and `macos tests` must be among them. A failed job stops the cut as
  soon as it shows.
- BUILD-INFO.json's `fullCheck` records the run, its attempt, its URL and each job's result
  (`kind: "github-actions"`), or the local test counts (`kind: "local"`).
- `--check local` always runs the whole check here, without asking GitHub; `--check ci` refuses to
  go on without the CI run.

**The Linux build** is dispatched (or, with `--linux-run <id>`, adopted) right after the
preconditions and builds while the Mac checks, builds and notarizes. A run that fails gets one
rerun of its failed jobs, at the same commit. If it still hasn't produced checked files, the draft
goes ahead with the Mac files, `release.json` records the run under `linuxPending`, and the next
step is `release:stable linux`. A `--dry-run` still stops on a failed Linux build.

It leaves a draft on `ANT1OFF/gram` (not a prerelease, not latest, with build notes that
publication replaces) with eleven assets (seven while the Linux files are pending): the signed
ZIP, `BUILD-INFO.json`, `BUNDLE-INVENTORY.json`, the bundle and web manifests, `SHA256SUMS.txt`
and electron-updater's `latest-mac.yml`, then the Linux AppImage, .deb, `LINUX-BUILD.json` and
`latest-linux.yml` (see [Linux files](#linux-files)). `release.json` in the work dir carries the version,
source, draft ID, asset table and minimum macOS for the next phases. Without `--stable`,
`release:rc` cuts a prerelease, which it publishes straight through and only from a private
repository.

## 1b. Linux files later: `release:stable linux`

Only when `release:rc` drafted the Mac files without the Linux ones:

```sh
bun run release:stable linux --work /tmp/rel-1.0.0               # rerun or wait for the recorded run
bun run release:stable linux --work /tmp/rel-1.0.0 --run <id>    # adopt another run for this release
bun run release:stable linux --work /tmp/rel-1.0.0 --dispatch    # a new run; needs main at the commit
```

It takes the run `release.json` recorded, waits for it, reruns its failed jobs once at the same
commit, and gives its files the same checks as `release:rc`: the run's jobs, `LINUX-BUILD.json`,
each package's size, SHA-256 and header, and `gh attestation verify`. It writes `latest-linux.yml`
with the app's renderer, rewrites `SHA256SUMS.txt` with the Mac lines unchanged (each still checked
against its file) plus the Linux files, and uploads the four Linux files and the new
`SHA256SUMS.txt` to the draft by its ID, replacing only a copy whose digest differs. It refuses a
draft whose Mac files changed, and checks every GitHub digest afterwards. A stop leaves the run to
pick up in `release.json`; it records the run it took (an adopted or newly dispatched one too)
before anything can fail, so running it again without `--run` resumes that run, uploads
included. `validate`, `update-check` and `publish` refuse the draft until it has passed.

**Mac-only, deliberately.** `validate`, `update-check` and `publish` also refuse a
`release.json` that records no Linux files at all, as an older work dir might, and one whose
assets lack any of them. Pass `--without-linux` to each of the three to publish such a release
anyway: once published it can never get the Linux files, so Linux installs and joined Linux
machines can't update to that version. The flag refuses a draft that has them.

## 2. Fresh-download validation: `release:stable validate`

```sh
bun run release:stable validate --work /tmp/rel-1.0.0
```

It downloads every draft asset into a new directory, compares GitHub's digests, sizes and
`SHA256SUMS.txt` with the local build, reads `latest-mac.yml` with electron-updater's own parser
and runs `codesign`, Gatekeeper and `stapler` on the extracted app. For the Linux files it checks
`LINUX-BUILD.json` (version, source commit, run, each package's size and SHA-256), reads
`latest-linux.yml` against the AppImage, and runs `gh attestation verify` on the AppImage and the
.deb.

## 3. Read-only update check: `release:stable update-check`

```sh
bun run release:stable update-check --work /tmp/rel-1.0.0
```

As the previous stable version, through the app's own feed under Bun, it checks the draft as
GitHub serves it (never offered) and then with its publication simulated (offered on both
channels), for the signed Mac, the AppImage and the .deb, each picking its own files. It writes
nothing to GitHub.

## 4. Publication: `release:stable publish`

```sh
bun run release:stable publish --work /tmp/rel-1.0.0 --dry-run
bun run release:stable publish --work /tmp/rel-1.0.0 [--notes notes/1.0.0.md]
bun run release:stable update-check --work /tmp/rel-1.0.0 --live
```

It refuses unless validation and the update check passed on these exact assets, the draft is
unchanged, no tag exists and `releases/latest` is still the version recorded at draft time (for a
first release: the repository still holds nothing but this draft).

**Notes.** Publication replaces the build notes with notes for people using the app, rendered from
the version's What's New cards or taken from `--notes <file>`, a file committed in the release's
source. Both are read from the release commit itself, and a fail-closed check refuses PR numbers,
commit SHAs, run IDs, test counts, paths, hosts, handles, other versions and links to anything but
this repository's public pages. Read `public-notes.md` in the work dir after the dry run.

One `PATCH` then publishes the draft with those notes as latest, with the tag on the source
commit, and the tool checks the tag, `releases/latest`, the notes and the assets. On a public
repository it then reads `releases/latest` and `latest-mac.yml` back with no credentials, as an
install would. If the answer to the `PATCH` is lost, it reads the release back and checks it the
same way.

## Linux files

`release:rc --stable` dispatches [release-linux.yml](../.github/workflows/release-linux.yml) on
`main` once its preconditions pass, with the version, the source commit and a nonce that names
the run. The workflow refuses to build unless main's head is that commit, since its attestation
names the run's commit; a rerun keeps the commit it started at. On GitHub-hosted `ubuntu-24.04`
runners, two jobs run side by side:

- `sherpa-onnx` rebuilds the committed TTS-free sherpa-onnx (`tools/sherpa-onnx/build-linux-x64.sh`,
  from its pinned sources) and requires the same bytes (about three minutes).
- `build` installs from the lockfile with no package-manager cache (only hash-verified packaging
  archives are cached), which puts those committed files in place, packages with the version
  stamped in, runs `verify:package`, installs the .deb on Ubuntu 24.04 and Debian 12, smokes the
  installed app and the AppImage, and checks the packaged version, source commit and .deb fields.
  Then it writes `LINUX-BUILD.json`.

`attest` needs both, so no package is attested unless the sherpa-onnx files it carries rebuilt the
same, and the release tools require all three jobs to have passed.

- The `build` and `sherpa-onnx` jobs have a read-only `contents` token. The `attest` job has `id-token` and
  `attestations` write, checks out nothing and runs no repository code: it compares the artifact
  with the build's digests and runs `actions/attest-build-provenance` on the two packages.
- Nothing in the workflow writes to a release. `release:rc` (or `release:stable linux`) waits for
  the run (the Mac build runs meanwhile), downloads the artifact and checks it. It runs `gh attestation verify` with the
  exact signer identity (`release-linux.yml@refs/heads/main`, not a prefix), `refs/heads/main`,
  the source commit and GitHub-hosted runners enforced, then
  writes `latest-linux.yml` with the app's renderer. The files go into `SHA256SUMS.txt` and the
  same `gh release create`, with your own login.
- `release:rc --stable --dry-run` dispatches the workflow with `dry_run`: it builds and checks
  everything but signs no attestation, and nothing is uploaded. A pull request that changes the
  workflow, `tools/release-linux/` or `tools/sherpa-onnx/` runs the same dry build.
- No GPG key or other secret is involved. The packages carry no publisher signature: their
  integrity rests on HTTPS to GitHub, the checksums and the attestation.

## Where the time goes

Measured from `release:rc` starting to `publish`: the left column on the 1.14.0 to 1.17.0 cuts,
which ran the tests on the Mac, and the right on the current cut, measured on 1.18.0 where it
says so:

| Phase                                               | Tests on the Mac                                                                                                  | Now                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Local Vitest run                                    | 5m 43s to 10m 56s                                                                                                 | none: main's push CI run on the release commit, while the Mac builds (1.18.0: about 21.5 minutes) |
| Static stages, build, package, notarize, smoke, ZIP | 2m 10s to 4m 20s                                                                                                  | the same                                                                                          |
| Linux run (dispatch to done)                        | 7m 13s to 11m 46s, with its sherpa-onnx rebuild (3m 06s) first                                                    | about 4 to 5 minutes, the rebuild beside the build                                                |
| Waiting on Linux after the Mac part                 | 1m 05s to 4m 27s                                                                                                  | about none                                                                                        |
| Draft upload, validate, update check, publish       | 1m 30s to 2m 30s                                                                                                  | the same                                                                                          |
| A failed Linux run                                  | the whole `release:rc` again, with `main` frozen (1.16.0: about 63 minutes)                                       | one rerun of its failed jobs, about 5 minutes, `main` open                                        |
| A test that flakes under load                       | the whole `release:rc` again and a new Linux run (1.17.0: 22 minutes from merge to publish, `main` frozen for 21) | can't happen here: the tests aren't rerun on the Mac                                              |

A clean cut takes about 25 minutes from the release PR's merge to `publish` (1.18.0: 24m 39s),
and `main` is frozen for about 3 minutes, until the Linux build is dispatched (1.17.0, which reran
the whole cut: 21 minutes). The critical path is `main`'s push CI run on the release commit, about
21.5 minutes, bound by runner availability rather than by the Mac or the Linux build. A heavy PR
merged in that window queues its own CI runs for the same runners, so hold heavy merges until that
run's jobs have all started.

## Record and limits

Keep the work dir: its `release.json`, `validate.json`, `update-check.json` and `publish.json`
hold the source, the release ID and URL, the asset tables, the checks and the publication time.

The update checks run in Bun, not Electron, so Squirrel.Mac's own signature check, staging and
relaunch are not exercised, and neither is the AppImage's download, replacement and relaunch.
Live providers and microphones aren't either. Prove an installed update by hand on a real
install of each.

`tools/release-stable/*.test.mjs` run the phases against a synthetic GitHub with immutable
releases and a fake `gh` (`tools/release-stable/testing/`), with stubs standing in for macOS's
verdicts on a signed app and Sigstore's on an attestation. `tools/release-linux/*.test.mjs`
cover the dispatch, adoption, reruns, the run checks, the artifact checks and the attestation
results against a synthetic `gh`, and `tools/release-rc/ci-check.test.mjs` the CI evidence.
