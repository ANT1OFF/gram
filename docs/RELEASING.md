# Releasing Gram

[Up: docs map](README.md) · [Updates](UPDATES.md) · [Public readiness](PUBLIC_RELEASE.md)

Releases, the update feed and issues all live in `ANT1OFF/gram`. A release is built and signed
once on an Apple silicon Mac, then goes through separate runs, each checked before the next:

1. a draft;
2. its fresh-download validation;
3. a read-only update check;
4. publication.

Merging code changes no installed app. An install changes only when its user updates it from a
published release.

## Versions

[Release-please](https://github.com/googleapis/release-please)
([release-please.yml](../.github/workflows/release-please.yml)) keeps a draft metadata PR on
`main` with the changelog, the root and desktop package versions, the desktop entry in `bun.lock`
and `.release-please-manifest.json`. Its baseline is the latest release's tag: no
`bootstrap-sha` pins history to a commit, so it counts the commits after `v1.0.0`, and before
that release exists, the repository's first commit, which is not a conventional commit and adds
nothing. Conventional squash titles decide the next
version: `fix:` proposes a patch, `feat:` a minor, and `docs:`, `refactor:` and `chore:` add no
entry. Merging that PR publishes nothing: `skip-github-release` is on, and no tag or release is
made.

After the release below is published, the publisher swaps the merged metadata PR's
`autorelease: pending` label for `autorelease: tagged`, so the next run proposes the following
version. Never clear the label for a version that did not ship.

`node tools/check-release-please.mjs` checks the configuration offline. The upstream dry-run
harness, `node tools/test-release-please.mjs <action-source>`, needs the pinned action's source
installed in a temporary directory with `npm ci --ignore-scripts --omit=dev`.

## Before you start

- **Access:** your own `gh` login with write access to `ANT1OFF/gram`. No other token is
  involved, and no call inherits `GH_TOKEN`, tracing or debug variables.
- **Signing:** the Developer ID identity and the `gram-notary` notarytool profile in your
  keychain (see [Developer ID signing](UPDATES.md#developer-id-signing)). Every release
  is Developer ID signed, notarized and stapled; there is no unsigned stable path.
- **Source:** the release PR is merged, all four version fields read the version, the exact
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
publication replaces) with seven assets: the signed
ZIP, `BUILD-INFO.json`, `BUNDLE-INVENTORY.json`, the bundle and web manifests, `SHA256SUMS.txt`
and electron-updater's `latest-mac.yml`. `release.json` in the work dir carries the version,
source, draft ID, asset table and minimum macOS for the next phases. Without `--stable`,
`release:rc` cuts a prerelease, which it publishes straight through and only from a private
repository.

## 2. Fresh-download validation: `release:stable validate`

```sh
bun run release:stable validate --work /tmp/rel-1.0.0
```

It downloads every draft asset into a new directory, compares GitHub's digests, sizes and
`SHA256SUMS.txt` with the local build, reads `latest-mac.yml` with electron-updater's own parser
and runs `codesign`, Gatekeeper and `stapler` on the extracted app.

## 3. Read-only update check: `release:stable update-check`

```sh
bun run release:stable update-check --work /tmp/rel-1.0.0
```

As the previous stable version, through the app's own feed under Bun, it checks the draft as
GitHub serves it (never offered) and then with its publication simulated (offered on both
channels). It writes nothing to GitHub.

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

## Record and limits

Keep the work dir: its `release.json`, `validate.json`, `update-check.json` and `publish.json`
hold the source, the release ID and URL, the asset tables, the checks and the publication time.

The update checks run in Bun, not Electron, so Squirrel.Mac's own signature check, staging and
relaunch are not exercised; neither are live providers or microphones. Prove an installed update
by hand on a real install.

`tools/release-stable/*.test.mjs` run the phases against a synthetic GitHub and a fake `gh`
(`tools/release-stable/testing/`), with a stub standing in for macOS's verdicts on a signed app.
