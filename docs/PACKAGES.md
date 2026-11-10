# Packages and images

[Up: Releasing](RELEASING.md) · [Docker](DOCKER.md)

Gram's core can be used without the desktop app: as registry packages, to embed it in another
program, and as container images, to host it yourself. This page covers what is published, how a
consumer depends on it, and the pipeline that publishes it.

**Publishing is off.** The pipeline builds and checks everything on every run, and uploads
nothing until the repository's owner [switches it on](#switching-it-on). Until then no package or
image exists in any registry.

## What is published

Five packages, always together at one version:

| Workspace name    | What it is                                                           |
| ----------------- | -------------------------------------------------------------------- |
| `@gram/contracts` | Schemas and types shared by every part: threads, RPC, settings       |
| `@gram/themes`    | The built-in themes and their tokens                                 |
| `@gram/git`       | Git, worktrees, bounded commands and the pull request model          |
| `@gram/agents`    | The Claude Code and Codex hosts, and their recorded test fixtures    |
| `@gram/server`    | The server, and the `gram-server` and `gram-host` commands it brings |

`@gram/shell` (the Electron shell) and the two apps are not published.

Two images, from one [Dockerfile](../docker/Dockerfile):

| Image       | Target                    | What it runs                                                                    |
| ----------- | ------------------------- | ------------------------------------------------------------------------------- |
| `gram`      | `control-plane` (default) | The server and the web app, as in [Gram in Docker](DOCKER.md)                   |
| `gram-host` | `host`                    | The worker host alone, which dials the Gram it [joined](MACHINES.md) and serves |

Both are built for `linux/amd64` and `linux/arm64`.

## Versions

- A **canary** is published for each commit on `main`. Its version is the patch after the one in
  `package.json`, then the commit's UTC time and hash:
  `1.18.1-canary.20261110231900.g664099538`. The registry tag `canary`, and the image tag
  `canary`, move to the newest.
- A **release** is published when a GitHub release is, at that release's version, tagged
  `latest`. See [Releasing](RELEASING.md).

Nothing promises compatibility between canaries. Pin one exact version of every package, and the
image with the same version, and move them together.

## Depending on the packages

A package registry only lets an account publish in its own scope, so outside the `@gram` scope a
package is published as `gram-<name>` in the publisher's: `@gram/contracts` becomes
`@<owner>/gram-contracts`. The code inside still imports `@gram/contracts`, so each package
depends on its siblings through an alias, and a consumer does the same:

```json
{
  "dependencies": {
    "@gram/contracts": "npm:@<owner>/gram-contracts@1.18.1-canary.20261110231900.g664099538",
    "@gram/server": "npm:@<owner>/gram-server@1.18.1-canary.20261110231900.g664099538",
    "effect": "4.0.6"
  }
}
```

With GitHub Packages, the consumer's `.npmrc` sends that scope to it. Reading a package there
needs a token with `read:packages`, even for a public one:

```ini
@<owner>:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

What a published package expects:

- **Node 26 or later** (`engines`), and ES modules.
- **One `effect`, at the exact version it names as a peer.** Install that version yourself. A
  second copy, or another version, breaks services at run time. The packages pin
  `@effect/platform-node-shared` to the same release, because `@effect/platform-node` asks for a
  range of it and a newer one needs a newer `effect`. If your package manager still picks a newer
  one, override it to the `effect` version.
- **Exact dependencies.** Every dependency is the exact version this repository's lockfile was
  built and tested with; none is a range.
- **Types built by the TypeScript version in the package's `gram.built` field.** The
  declarations import their neighbours with `.ts` extensions, which TypeScript resolves to the
  `.d.ts` files beside them.
- **Native modules.** `node-pty` and `@parcel/watcher` come from npm and need their install
  scripts allowed.

The Windows patch this repository applies to `@effect/platform-node-shared` is not part of the
published packages.

Each package's `gram.commit` names the commit it was built from. The only entries are the ones
in its `exports`; `@gram/server/main` starts the server when imported, and `gram-server` is the
same thing as a command.

## Images

```sh
docker build -f docker/Dockerfile -t gram .
docker build -f docker/Dockerfile --target host -t gram-host .
```

The host image holds the whole host in `/opt/gram-host`: one bundle, `gram-host.js`, and the two
native modules it loads. That folder runs under any Node 26 on the same architecture and C
library, so another image can take it instead of starting from this one:

```dockerfile
COPY --from=ghcr.io/<owner>/gram-host:<version> /opt/gram-host /opt/gram-host
```

The image runs `gram-host run` as the user `gram` and listens on nothing. It keeps its join and
key in `/home/gram/.gram-host`, so put `/home/gram` on a volume and join once:

```sh
docker run -it -v gram-host-home:/home/gram gram-host gram-host join --no-service
```

A host built this way reports no release of its own, as one run from source does.

## The pipeline

[packages.yml](../.github/workflows/packages.yml) runs on every push to `main`, on a published
release, by hand, and on a pull request that changes the workflow, `tools/packages/`, the
Dockerfile or a published package's manifest. Every run:

1. builds the packages and packs them (`bun run packages:pack`);
2. installs the tarballs with npm in an empty project outside the workspace, imports every
   export, typechecks a consumer against the published types, and starts `gram-server` and
   `gram-host` from their installed commands (`bun run packages:verify`);
3. rehearses the publish with `--dry-run`;
4. builds both images on both architectures and starts the host one.

Only a push to `main` and a published release go on to upload, and only when the switch is on.
A version the registry already has is left alone, so a failed run can be run again. The job that
holds the package-writing token installs nothing and runs one dependency-free script over the
tarballs the first job checked, each against its recorded hash.

To run the same checks locally, after `bun run typecheck`:

```sh
bun run packages:pack --canary --scope @<owner>
bun run packages:verify
```

The tarballs land in `out/packages/`. Neither command publishes.

## Switching it on

These are the owner's decisions; nothing in the repository makes them.

| Repository variable     | Value    | Effect                                                                            |
| ----------------------- | -------- | --------------------------------------------------------------------------------- |
| `GRAM_PUBLISH_PACKAGES` | `true`   | Canaries from `main` and versions from releases go to GitHub Packages and `ghcr`  |
| `GRAM_RELEASE_REGISTRY` | `npm`    | Releases' packages go to npm instead of GitHub Packages. Canaries never go to npm |
| `GRAM_NPM_SCOPE`        | `@scope` | The npm scope releases are published in; required with the line above             |

With only the first set, everything goes to GitHub Packages under the repository owner's scope,
with the workflow's own token: no secret is needed. Publishing to npm also needs the scope to
exist there, and either a trusted publisher set up for this workflow on each package or an
`NPM_TOKEN` secret. The npm path has not been exercised.

Published versions can't be replaced, and GitHub Packages keeps every canary until it is deleted
there.
