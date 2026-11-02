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
.deb are built and checked.

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

It runs the full check once, builds and packages once, signs every nested binary with the
hardened runtime, notarizes and staples, then checks `codesign --verify --deep --strict`,
`stapler validate`, Gram's designated requirement and `spctl`. It inspects the package, loads the
speech and PTY natives and runs the packaged `--smoke` with fake agents. Check, build and smoke
run with a temporary HOME, temporary stores and stub `claude`, `codex` and `gh`.

It leaves a draft on `ANT1OFF/gram` (not a prerelease, not latest, with build notes that
publication replaces) with eleven assets: the signed
ZIP, `BUILD-INFO.json`, `BUNDLE-INVENTORY.json`, the bundle and web manifests, `SHA256SUMS.txt`
and electron-updater's `latest-mac.yml`, then the Linux AppImage, .deb, `LINUX-BUILD.json` and
`latest-linux.yml` (see [Linux files](#linux-files)). `release.json` in the work dir carries the version,
source, draft ID, asset table and minimum macOS for the next phases. Without `--stable`,
`release:rc` cuts a prerelease, which it publishes straight through and only from a private
repository.

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
names the run's commit. On a GitHub-hosted `ubuntu-24.04` runner it installs from the lockfile
with no Actions cache at all (not even setup-bun's or setup-node's), packages with the version
stamped in, runs `verify:package`, installs the .deb on Ubuntu 24.04 and Debian 12, smokes the
installed app and the AppImage, and checks the packaged version, source commit and .deb fields. Then it writes `LINUX-BUILD.json`.

- The `build` job has a read-only `contents` token. The `attest` job has `id-token` and
  `attestations` write, checks out nothing and runs no repository code: it compares the artifact
  with the build's digests and runs `actions/attest-build-provenance` on the two packages.
- Nothing in the workflow writes to a release. `release:rc` waits for the run (the Mac build runs
  meanwhile), downloads the artifact and checks it. It runs `gh attestation verify` with the
  exact signer identity (`release-linux.yml@refs/heads/main`, not a prefix), `refs/heads/main`,
  the source commit and GitHub-hosted runners enforced, then
  writes `latest-linux.yml` with the app's renderer. The files go into `SHA256SUMS.txt` and the
  same `gh release create`, with your own login.
- `release:rc --stable --dry-run` dispatches the workflow with `dry_run`: it builds and checks
  everything but signs no attestation, and nothing is uploaded. A pull request that changes the
  workflow or `tools/release-linux/` runs the same dry build.
- No GPG key or other secret is involved. The packages carry no publisher signature: their
  integrity rests on HTTPS to GitHub, the checksums and the attestation.

## Record and limits

Keep the work dir: its `release.json`, `validate.json`, `update-check.json` and `publish.json`
hold the source, the release ID and URL, the asset tables, the checks and the publication time.

The update checks run in Bun, not Electron, so Squirrel.Mac's own signature check, staging and
relaunch are not exercised, and neither is the AppImage's download, replacement and relaunch.
Live providers and microphones aren't either. Prove an installed update by hand on a real
install of each.

`tools/release-stable/*.test.mjs` run the phases against a synthetic GitHub and a fake `gh`
(`tools/release-stable/testing/`), with stubs standing in for macOS's verdicts on a signed app
and Sigstore's on an attestation. `tools/release-linux/*.test.mjs` cover the dispatch, the run
checks, the artifact checks and the attestation results against a synthetic `gh`.
