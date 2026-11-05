# Gram

[![Latest release](https://img.shields.io/github/v/release/ANT1OFF/gram)](https://github.com/ANT1OFF/gram/releases/latest)
[![CI](https://github.com/ANT1OFF/gram/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/ANT1OFF/gram/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/github/license/ANT1OFF/gram)](LICENSE)

A macOS app where an orchestrator agent runs a team of Claude Code and Codex workers for you, each
in its own git worktree, from task to merged pull request.

![Gram on a workspace's orchestrator. The sidebar lists its workers and their state: one asks you, one is editing code, one has a pull request in review and one is waiting on checks, then a few solo threads. In the middle, the task given to the orchestrator, its reply that it started six workers, and a card per feature with each worker's state and pull request, two of them merged. At the bottom, the one question waiting on you, with the orchestrator's note and a recommended answer.](docs/assets/gram-orchestrator.png)

- **An orchestrator per workspace.** You give it tasks; it writes a brief for each, starts a
  worker on it and answers what it can, passing the rest to you.
- **Isolated workers.** Each worker is a normal Claude Code or Codex thread in its own worktree
  and branch, so your checkout stays as it was. Open any of them to read, steer or answer it.
- **Woken by events, not polling.** The thread that cares wakes when CI settles, a review lands,
  a pull request merges or a time it set comes round.
- **Autonomy you choose.** Supervised asks before anything leaves your machine, Publish pushes
  and opens pull requests, and Full also merges on its own.
- **One Inbox for what needs you.** Questions, approvals, plans, reviews and failures from every
  workspace collect in one list, each answered beside it.

## Requirements

- macOS on Apple silicon, or Linux on x64 (the AppImage, or the .deb for Debian 12, Ubuntu 24.04
  and later). On Linux, gateway keys need a desktop keyring (GNOME Keyring or another Secret
  Service, or KWallet), and voice dictation uses the system's default input through PipeWire or
  PulseAudio.
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) and/or the
  [Codex CLI](https://github.com/openai/codex), installed and signed in (`claude /login`,
  `codex login`). Gram runs them on your own subscriptions; no API key is needed.
- Optional: the [GitHub CLI](https://cli.github.com) (`gh auth login`) for pull requests, checks
  and merges.

## Install

Download from the [latest release](https://github.com/ANT1OFF/gram/releases/latest):

- **macOS:** `gram_<version>_darwin-arm64_signed.zip`. Unzip it and move `Gram.app` to
  Applications. It is Developer ID signed and notarized.
- **Linux AppImage:** `gram_<version>_x86_64.AppImage`. Make it executable and run it:
  `chmod +x gram_<version>_x86_64.AppImage && ./gram_<version>_x86_64.AppImage`. It needs FUSE 2
  (`libfuse2t64` on Ubuntu 24.04) and updates itself from Settings → About.
- **Linux .deb:** `sudo apt install ./gram_<version>_amd64.deb`. Settings → About says when a
  new release is out; install it the same way.

[Updates](docs/UPDATES.md#installing-a-release) covers checking the download against
`SHA256SUMS.txt` and its build attestation, and how Gram updates itself.

## Build from source

```sh
bun install --frozen-lockfile
bun run dev:desktop
```

[Development](docs/DEVELOPMENT.md) has the toolchain versions, every run and check command, and
packaging.

## Why

I kept ending up with five to ten Claude Code sessions open at once, and the hard part was keeping
track of what each was doing, what it was waiting on and what came next. That bookkeeping is
something an agent is good at, so Gram hands it to an orchestrator agent.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/how-it-works-dark.svg">
  <img src="docs/images/how-it-works-light.svg" alt="How Gram works: you give the orchestrator goals, answers and approvals. In the workspace, the orchestrator keeps a memory of goals, decisions and rulings, sends briefs to workers and gets reports and questions back. Each worker runs Claude or Codex in its own worktree, and workers message each other. Workers open pull requests, which go through checks, merge and release. CI, review and merge events wake the worker that owns the pull request, and the orchestrator gets a digest.">
</picture>

A workspace is one or more repositories with one long-lived orchestrator thread. You keep coming
back to it rather than starting a fresh chat per task: it is where you talk through priorities,
and where results, blockers and questions come back to you. Its memory of your decisions and
standing rulings, and the digests it gets from workers, carry it across sessions.

- **Messaging.** Orchestrator and workers talk both ways, and workers can message each other.
- **Models by assignment.** Each workspace lists the models its workers may use, with a note on
  what each is for: for example, implementation on Claude, independent reviews on Codex, and
  specialised work on a model you pick for it.
- **The Board.** Each feature's workers and pull requests on one line, from briefed to merged.

![Gram's Board view: three features as rows across the columns Briefed, Working, Checks, Review and Merged. Each worker is a card in its column: one asks you, one is working, one waits on checks, one is in review and two have merged. The one question waiting on you is docked below.](docs/assets/gram-board.png)

Gram doesn't prescribe a way of working. The same pieces run as a swarm of workers in parallel
that message each other, or with the orchestrator calling on one worker for one job.
[Agents and features](docs/AGENTS_AND_FEATURES.md) covers it in depth.

## Quiet

Watching a wall of agents work is a constant dopamine drip: something is always moving, and it
pulls your attention all day. Quiet hides all of that and shows only what needs you, one card at a
time, with a dot per worker along the bottom. Get on with your own work and come back when you're
asked. Open it from the title bar's … menu or ⌘⌥4 (Ctrl+Alt+4 on Linux), and leave with Esc;
**Quiet when idle** in Settings → General turns it on after five idle minutes with nothing asked.

![Gram's Quiet view at rest: an otherwise empty window that reads "Nothing needs you. 5 workers are busy: 2 working, 3 waiting on checks." Along the bottom, the workspace's name with a dot per worker, filled for the two working and hollow for the three waiting, and the time; Leave quiet sits in the top corner.](docs/assets/gram-quiet.png)

## Docs

- [Agents and features](docs/AGENTS_AND_FEATURES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Development](docs/DEVELOPMENT.md) and [testing](docs/VERIFICATION.md)
- [Updates](docs/UPDATES.md) and [releasing](docs/RELEASING.md)
- [Design notes](DESIGN.md)

The [docs map](docs/README.md) lists every page and what it covers.

## Contributing and security

[Contributing](CONTRIBUTING.md) covers branches, checks and pull requests. Report vulnerabilities
privately as described in the [security policy](SECURITY.md).

## License

[MIT](LICENSE). Bundled dependencies keep their own licenses; see
[packaged dependency notices](docs/DEVELOPMENT.md#packaging-and-dependency-notices).
