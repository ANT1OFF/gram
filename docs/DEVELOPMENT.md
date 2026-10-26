# Developing Gram

[Up: Gram](../README.md) · [Docs map](README.md)

This guide owns local setup and run commands. For check selection use
[testing](VERIFICATION.md); for actual accounts, native GUI and packaging acceptance
use the separate [acceptance guide](development/ACCEPTANCE.md).

## Toolchain and install

Use the Bun version in [.bun-version](../.bun-version) and the host Node version in
[.node-version](../.node-version). Bun installs and runs scripts; Node runs the server,
native modules, Vitest, Playwright, Vite and Electron tooling. Do not force these
through `bun --bun` or replace Vitest with `bun test`. Electron embeds its own Node;
the host pin does not change that runtime. The exact package versions, Electron's
among them, live in [package.json](../package.json).

```sh
bun install --frozen-lockfile
bun run check:scaffold
```

Git is required for worktrees. Install and sign into whichever agent CLI you want
(`claude /login`, `codex login`); `gh auth login` is optional for GitHub workflows.
No organization account, private registry or gateway is needed. CLI model discovery
and entitlement limits are described in [agents and features](AGENTS_AND_FEATURES.md).

On Linux, node-pty's install hook needs Python 3, make, a C++ compiler and Node
headers. Live port discovery also needs `lsof` and `ps` on PATH. The exact root `node-gyp` dependency and explicit hoisted linker in
[bunfig.toml](../bunfig.toml) support native hooks. Only Electron and node-pty
are trusted for dependency lifecycle scripts. Correct a failed hook before
claiming native loading; a no-op install need not rerun it. No blanket script trust.

Run from the checkout's physical directory (`pwd -P`). In particular, macOS
`/tmp` resolves to `/private/tmp`; passing another checkout's absolute tsconfig
to `tsc -b` can lose project-reference redirects. Use the root scripts in the
actual checkout. Keep `bun.lock`, catalog, native overrides and the existing
Effect patch intact. No pnpm is required.

## Run locally

| Command                                 | Behavior                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `bun run dev:desktop`                   | Electron, server and Vite; real installed agents by default              |
| `GRAM_FAKE_AGENT=1 bun run dev:desktop` | Desktop with the echo fake agent                                         |
| `bun run dev`                           | Web UI and local Node server; echo agent by default                      |
| `GRAM_FAKE_AGENT=0 bun run dev`         | Web UI/server using installed agents                                     |
| `bun run dev:mock`                      | Mock UI without server or agent processes                                |
| `bun run dev:preview`                   | Owned browser/Vite mock preview with fresh storage and retained evidence |
| `bun run build`                         | Typecheck, then web and desktop bundles                                  |

For isolated UI inspection and a signed-out capture, use the
[preview procedure](VERIFICATION.md#isolated-ui-preview). It uses the installed
pinned Chromium and browser mocks; the launcher owns its Vite/browser cleanup.

Use `GRAM_DATA_DIR=<temporary-folder>` for disposable server data. It does **not**
isolate Electron's window state, trusted hosts or gateway vault. Isolate the shell
profile with `--user-data-dir` for packaged GUI acceptance as documented in the
[acceptance guide](development/ACCEPTANCE.md). Never copy credential stores into
an acceptance profile.

The web loop chooses free ports from server 4317 and web 5173 unless `GRAM_PORT`
or `GRAM_WEB_PORT` pins them. Desktop uses the same port helper. A boot URL grants
local API access; keep it local and out of issues, PRs and uploaded logs. Browser
opening is restricted to interactive development; `GRAM_NO_OPEN=1` disables it.
Source: [web dev loop](../apps/web/scripts/dev.mjs),
[desktop dev loop](../apps/desktop/scripts/dev.mjs).

For opt-in phone access to the existing server over private Tailscale HTTPS, follow
[private mobile browser access](REMOTE_ACCESS.md). Pairing and remote authentication
are separate from the desktop boot token.

## Browser and native prerequisites

Install Playwright Chromium from the web workspace; Linux also needs its system
libraries (the CI image uses the `--with-deps` form):

```sh
cd apps/web
bun run playwright install --with-deps chromium
```

Return to the root for browser commands:

```sh
bun run e2e:smoke
bun run --filter @gram/web e2e
bun run e2e:real
```

`GRAM_E2E_CHROMIUM=/absolute/path/to/chromium` selects an existing compatible
browser for both suites. Mock global setup builds `dist-e2e`, starts its own
token-checked server on 127.0.0.1 and warms routes. Each checkout searches for a free
port from its own start (derived from its path); `GRAM_E2E_PORT` pins one and refuses
an occupied one. Real-server setup builds web/server bundles and runs isolated
temporary repos with fake agents/`gh`, one worker and no retries; it refuses
Windows. See [testing](VERIFICATION.md#browser-checks) before reusing a build.

Local directory packaging never publishes:

```sh
bun run --filter @gram/desktop dist:dir
bun run --filter @gram/desktop verify:package
```

`verify:package` reads the package lists the build wrote to `out/notices/lists`, so
run it after the build that made the package. The shipped main, preload, server,
command-worker and speech bundles are minified with only license comments kept
(`apps/desktop/shipped-code.ts`); the dev loop builds them readable with
`GRAM_READABLE_BUNDLES=1`, which `verify:package` rejects. Packaging flips Electron's
fuses (`electronFuses` in `electron-builder.yml`): NODE_OPTIONS and inspect flags off,
ASAR integrity and only-ASAR on, `RunAsNode` on for the release tool's native probe.

Local `dist:dir` packaging is unsigned; signing is part of [releasing](RELEASING.md).
Linux smoke may need Xvfb. Native loading is
separate from real accounts, microphone capture and recognition quality. Releases
follow [releasing](RELEASING.md).

## Continue work

[Architecture](ARCHITECTURE.md) maps the packages and boundary owners.
[Contributing](../CONTRIBUTING.md) covers PRs, reviews and merging.
[Public readiness](PUBLIC_RELEASE.md) lists qualification limits, and
[releasing](RELEASING.md) covers versions and publication.
