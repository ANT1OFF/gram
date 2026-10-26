# Updates and signing

[Up: releasing](RELEASING.md)

Releases are Developer ID signed macOS Apple Silicon builds, and they update through Electron's
own updater; see [Signed installs: Electron's updater](#signed-installs-electrons-updater). The
Windows build has an updater that reads releases through your installed `gh` and verifies the
installer's Authenticode signature, but no Windows releases are published. Nothing here
publishes or activates releases.

## Installing a release

1. Download `gram_<version>_darwin-arm64_signed.zip` and `SHA256SUMS.txt` from the latest
   release on [Releases](https://github.com/ANT1OFF/gram/releases).
2. Check the download: `shasum -a 256 --ignore-missing -c SHA256SUMS.txt`.
3. Unzip it and move `Gram.app` to Applications. Stable releases are Developer ID signed and
   notarized, so macOS opens them without extra steps.
4. Open Gram, add a repository and start a thread, or create a workspace and give its
   orchestrator a task.

Settings → Updates checks GitHub Releases anonymously; no sign-in or `gh` is needed. Automatic
checks are off until you turn them on; downloading and installing are each a click. Each release's notes are on its GitHub release page.

## Unsigned macOS installs

Unsigned macOS builds, such as a local `dist:dir` package, have no in-app updater. Settings →
Updates still shows the running build, and a check there reports updates as unavailable, with the
reason: only Developer ID signed builds update themselves. To get updates, install a signed
release.

## Running build and release status

Settings → Updates shows the running desktop's version independently of release checks.
New desktop builds embed a source revision only when built from a clean Git checkout
whose canonical worktree root is the build source root;
development runs, dirty builds and source archives without Git explain unknown source
metadata. This is build provenance, not publisher signing or a claim
that a same-version release has identical installed bytes. Gram never reads runtime
Git state or infers the running binary from main or a user-reported installation.

## Developer ID signing

Gram can be signed with the owner's own Developer ID, notarized by Apple and
stapled. Signing is a separate step after packaging
([sign-mac.mjs](../apps/desktop/scripts/sign-mac.mjs)), which `bun run release:rc --stable`
runs; a release can't be published without it. Nothing in Gram reads a certificate, private
key, password or API key: `codesign` gets the identity's Keychain name and
`notarytool` gets a keychain profile name.

### One-time setup

1. **Certificate.** In Xcode, open Settings → Accounts, choose the team, then Manage
   Certificates → + → **Developer ID Application**. Alternatively, create one in the
   developer portal and open it into the login keychain. Check that
   `security find-identity -v -p codesigning` lists
   `Developer ID Application: <Name> (<TEAMID>)`.
2. **Notarization credentials.** The preferred option is an App Store Connect API key:
   in Users and Access → Integrations → Team Keys, use the Developer role and download
   the `.p8` once. An app-specific password for your Apple Account also works.
3. **Keychain profile.** Store the credentials once under the name `gram-notary`:
   `xcrun notarytool store-credentials gram-notary --key <AuthKey.p8> --key-id <ID> --issuer <UUID>`,
   or `--apple-id <email> --team-id <TEAMID> --password <app-specific password>`.
   After that, the `.p8` can live somewhere offline.
4. **Activation.** `GRAM_MAC_TEAM_ID` in
   [mac-signature.ts](../packages/shell/src/modules/update/mac-signature.ts) is the
   Team ID, `ANVR857GFZ`. It isn't secret. This one constant tells the signer, the
   release script and the updater which publisher to trust. Setting it to `null`
   would switch signing off.

### What a signed build is

- **Code.** Every nested Mach-O is signed inside out with the hardened runtime and a
  secure timestamp: Electron's helpers and frameworks, node-pty's `spawn-helper` and
  addon, the speech addon and its ONNX Runtime dylibs.
- **Entitlements.** [The entitlements file](../apps/desktop/build/entitlements.mac.plist)
  grants only `allow-jit` (V8) and `device.audio-input` (dictation). Library validation
  stays on, because one team signs every bundled library.
- **Notarization.** The app is notarized and stapled. The signer then requires
  `codesign --verify --deep --strict`, `xcrun stapler validate`, Gram's designated
  requirement and `spctl --assess` with `source=Notarized Developer ID`.
- **Designated requirement.** Apple's Developer ID chain, the identifier
  `io.github.ant1off.gram` and the team as the leaf certificate's organizational unit.
- **Release assets.** `gram_<version>_darwin-arm64_signed.zip`, and a
  `BUILD-INFO.json` that records `developerIdSigned`, `notarized`, `stapled`, the Team
  ID, the requirement's SHA-256 and the notarization submission.

### How a signed build updates

A signed install updates through Electron's updater; see
[Signed installs: Electron's updater](#signed-installs-electrons-updater). It only ever accepts a
release signed by the same team.

## Signed installs: Electron's updater

A Developer ID signed install whose bundle macOS reports as signed by Gram's team
(`GRAM_MAC_TEAM_ID`) updates through [electron-updater](https://www.electron.build/auto-update)
on Squirrel.Mac. Unsigned installs, and any whose signature macOS can't read, have no in-app
updater. A signed install only ever accepts a release signed by the same team.

### Where releases come from

- **The public feed.** A custom electron-updater provider
  ([native-feed.ts](../apps/desktop/src/main/update/native-feed.ts)) reads `ANT1OFF/gram`'s
  release list and the release's manifest from GitHub's API anonymously, with no cookies,
  credentials or `gh`, picks a release by the rules below, and electron-updater downloads the
  ZIP from the release's download URL. Anonymous checks share GitHub's unauthenticated rate
  limit for the network; a check that hits it, or finds GitHub unreachable, says it couldn't
  check, and the next check tries again. `gh` plays no part in a signed install's updates.
- The checks Gram runs on the download itself, below, include GitHub's SHA-256 digest.
- **One channel.** Settings offers no channel choice: the public repository publishes stable
  releases only. The updater still keeps Stable and Pre-release apart, for a repository that
  publishes RCs.
- **Picking a release.** Stable offers only stable releases; Pre-release offers RCs and
  stable releases. A release is offered only when it is newer than the running version
  and carries both `gram_<v>_darwin-arm64_signed.zip` and its manifest (`rc-mac.yml` for
  an RC, `latest-mac.yml` for stable), each exactly once and fully uploaded, with
  GitHub's prerelease flag agreeing with its tag. Drafts, unsigned releases and ones still
  uploading are passed over. The manifest must name
  exactly that ZIP, GitHub's size for it and a SHA-512, and nothing else (no staging
  percentage, no minimum OS, no other URL). Downgrades are never offered.

### Checks, download and restart

- With **Check for updates automatically** on, main checks 15 s after launch and then
  every 4 minutes, never during a download, a ready update or a restart, and never in
  smoke runs or CI. Settings and the update pill can check at any time. Checks never
  download or restart anything.
- **Download** is a click. Progress shows as a percentage. Differential downloads are
  off, so there are no block maps to publish or trust.
- **Verified before it can be offered, on bytes Gram owns.** electron-updater's cache is a
  shared path, so Gram first copies the download into a fresh private directory
  ([native-snapshot.ts](../apps/desktop/src/main/update/native-snapshot.ts)). The copy is
  read-only and held open by descriptor. The copy's SHA-256 must equal
  GitHub's digest for the asset. Then
  ([native-candidate.ts](../apps/desktop/src/main/update/native-candidate.ts)) Gram unpacks
  that copy with its own bounded reader and requires all of these:
  - Info.plist's identity and versions, and app.asar's packaged version, equal the offered
    version, so an old signed ZIP republished under a newer version is refused;
  - that version is strictly newer than the running one and on the chosen channel;
  - `codesign --verify --deep --strict` passes against Gram's requirement for the team,
    with the hardened runtime;
  - Gatekeeper accepts it as `Notarized Developer ID`, with a valid stapled ticket.

  Squirrel.Mac checks the signature against this app's requirement, but neither
  notarization nor the version. Only then is the download **Ready**.

- **Squirrel.Mac is served that snapshot alone.** At staging, Gram points Squirrel.Mac at
  its own loopback feed for that one attempt
  ([native-squirrel-feed.ts](../apps/desktop/src/main/update/native-squirrel-feed.ts)),
  never at electron-updater's proxy, which would reopen the cache path. The feed streams
  from the snapshot's descriptor, hashing as it goes. It withholds the last chunk unless
  the stream's SHA-256 is the verified one, so replacing the cache, or changing the copy
  in place, can't change what gets installed: the download just never completes.
- **Restart to update** is a click too. Nothing is handed to Squirrel.Mac before then
  (`autoInstallOnAppQuit` is off), so an ordinary quit never installs anything. The
  restart then runs Gram's update stop fence: the server attests sessions, the database
  and owned agents, then the rest of its tree is killed, and speech, voice models and
  window state finish. If an essential fails, nothing quits: the server, voice and
  windows come back and the pill shows the reason in one line ("Didn't restart: an agent
  didn't stop cleanly. Nothing was installed."). A quit asked for before Squirrel.Mac is
  invoked cancels the restart. Abort is checked again after each step and right before
  the invocation.
- **An install macOS has pending from before** (ShipIt's `ShipItState.plist` or its
  `io.github.ant1off.gram.ShipIt` launchd job) is checked at launch and before each
  restart. Gram removes it, and if it can't show it gone (or can't tell), Gram holds as an
  update would, since any exit could install it:
  - the stop fence runs, quitting becomes the safe way out, and normal operation returns
    only once **Try again** shows the pending install gone;
  - if the fence refuses, everything comes back, but every quit runs the fence first, and
    one it refuses doesn't exit. Ordinary and forced quit never skip it.
- **Invoking Squirrel.Mac is a possible commit.** Past the fence, Gram writes an install
  record and asks Squirrel.Mac to stage the download. Squirrel.Mac unpacks it, checks its
  code signature against the running app's designated requirement (Gram's identifier,
  Gram's team, Apple's Developer ID chain), then writes ShipIt's request and submits its
  job, after which any exit installs it. So from the invocation on, Gram joins
  Squirrel.Mac's outcome and never races it, and a quit no longer cancels anything.
  - **Taking longer than 3 minutes** only changes the message ("macOS is still preparing
    the update"). Gram keeps waiting with everything stopped, and quitting is safe.
  - **If Squirrel.Mac refuses,** Gram removes ShipIt's job and request and checks that
    neither remains. Only then do the server, voice and windows come back and the record
    go. If they can't be shown gone, Gram stays stopped and keeps the record; quitting
    finishes it either way.
  - **Once staged,** Gram quits into the update. If the relaunch hasn't happened 60 s
    later, Gram exits anyway, so the installer can run.
- **Not applied.** On the next launch, the install record is read once and removed. If
  Gram still runs the version that quit, the pill and Settings say the update wasn't
  applied and point at Squirrel.Mac's log,
  `~/Library/Caches/io.github.ant1off.gram.ShipIt/ShipIt_stderr.log`, until dismissed.
- Squirrel.Mac replaces the app in place and keeps no backup. Workspace data is never
  part of the app.

### What a release carries

A release carries the six assets plus its manifest (`latest-mac.yml`, or `rc-mac.yml` for a
prerelease). `release:rc` renders the manifest with the app's own renderer
([native-release.ts](../packages/shell/src/modules/update/native-release.ts)) and reads it back
through electron-updater's parser and the app's validation before upload.
The packaged app carries an `app-update.yml` that names only electron-updater's cache
directory (`~/Library/Caches/gram-updater`); the feed is always set in code.

### Limits

Every check, provider, fence and record path above is covered by synthetic tests: a fake
`gh` with explicit auth state, a fake Squirrel.Mac port and temporary files. The real
Squirrel.Mac install, signed A→B, and the public feed against a real public repository
have not been exercised; the public feed's tests run against a synthetic GitHub on loopback.

## Shutdown attestation

The shutdown attestation covers completed Gram session persistence/layer finalization
and observed owned-child cleanup, including refusing SIGKILL/grace-timeout/crashed
child outcomes. Owned spawn lifetime observers run before host removal/release
listeners, so natural abnormal exits during shutdown cannot disappear from the host
set without recording failure. Only direct-child SIGTERM requested by `stopChild`
is accepted as expected cleanup. POSIX cleanup
waits for the direct child; it does not establish every descendant's quiescence.
SDK-owned processes (including Claude's synchronous SDK close) provide their own
close contract and do not expose every exit/force/descendant outcome here. Gram
assumes those close contracts and direct-child completion stop their writers; it
cannot attest an OS-wide absence of descendant writers. Strict descendant/process
health acknowledgement needs separate work before a stronger guarantee is claimed.
