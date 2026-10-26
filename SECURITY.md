# Security policy

[Up: Gram](README.md) · [Contributing](CONTRIBUTING.md)

## Reporting a vulnerability

Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/ANT1OFF/gram/security/advisories/new).
Please don't open a public issue, pull request or discussion for it. Include the version, what you
did and what happened, and how to reproduce it if you can.

## Supported versions

Only the [latest release](https://github.com/ANT1OFF/gram/releases/latest) gets security fixes.
Fixes ship in a new release, not as patches to older ones.

## Scope

- The Gram desktop app: its renderer, its loopback server and the opt-in remote access.
- Its update feed: how releases are signed, published and checked before an install accepts one.
- How it handles the user's local Claude Code and Codex CLIs: their logins, credentials,
  permissions, approvals and helper context consent.

Bugs in Claude Code, Codex, GitHub or other upstream projects belong with those projects. The
boundaries Gram means to keep are in [local trust boundaries](docs/ARCHITECTURE.md#local-trust-boundaries).
