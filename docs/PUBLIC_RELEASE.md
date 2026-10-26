# Public readiness and security limits

[Up: Gram](../README.md) · [Releasing](RELEASING.md)

Gram's source and releases live in one public repository, `ANT1OFF/gram`, under the
[MIT License](../LICENSE). This page owns the security boundaries Gram keeps and what has not
been qualified yet. Current behaviour is in [agents and features](AGENTS_AND_FEATURES.md) and
setup in [development](DEVELOPMENT.md).

## License and dependencies

MIT covers Gram's own code. Dependencies keep their own licenses: packaged builds carry a
generated `THIRD-PARTY-NOTICES.txt` ([generator](../tools/notices/generate.mjs)), which includes the
[motion kit notices](../apps/web/src/motion/THIRD-PARTY-NOTICES.md) and the
[terminal symbol font notices](../apps/web/src/panels/terminal/fonts/THIRD-PARTY-NOTICES.txt).
The packages stay `"private": true`: nothing is published to npm.

## Security boundaries

- **Agents.** Gram runs only the user's installed Claude Code and Codex CLIs, with their own
  logins. Gateways are opt-in, and a
  local subscription never falls back to an API key on its own.
- **Credentials.** Gram never reads the Claude Code login token. For Codex it links the CLI's own
  auth file into Gram's Codex home without reading it. Gateway keys stay in Gram's local vault.
  Subscription credentials stay isolated per provider.
- **Consent and approvals.** Helper context consent is separate per provider and scope. Agent
  actions that change things outside the conversation (merges, settings, outward messages) go
  through their approval cards, and Full Auto never lifts the user's own holds.
- **Codex ownership.** One Codex thread has one writer: the exit-only ownership fence refuses a
  second app-server reopening it while the first lives
  ([details](AGENTS_AND_FEATURES.md#codex-ownership-and-reopening)). Don't weaken it to pass a test.
- **Helpers and Dream** have their own permission contracts. Guided Codex helpers keep some
  native tools and ambient CLI context, so neither is a tool-free or file-only guarantee.
- **The app.** The renderer is sandboxed and context-isolated, with no Node integration and
  DevTools only in development. The local server listens on loopback, checks Host and Origin and
  needs a per-launch token. Phone access over Tailscale is opt-in ([remote access](REMOTE_ACCESS.md)).
- **No telemetry,** analytics or crash reporting.
- **The scaffold check** looks for known private identifiers, the project's former names and
  credential signatures. Passing it is not a confidentiality review or a security audit.

## Updates

Developer ID signed macOS builds update through Electron's updater from `ANT1OFF/gram`'s releases,
reading them anonymously. A signed install only accepts a release
signed by the same team, and nothing installs without the user's click. Automatic checks are off
by default. Unsigned builds don't update themselves. See the [updater contract](UPDATES.md).
