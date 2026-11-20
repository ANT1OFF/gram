# Working on Gram

Gram is a desktop app for individual developers who run their own installed Claude Code and
Codex CLIs on their own subscriptions. [README](README.md) introduces it,
[contributing](CONTRIBUTING.md) covers branches, checks and pull requests, and the
[docs map](docs/README.md) leads to the rest.

- Start from `docs/features.json` to find the code, tests and docs for a feature the person
  named, in the app's own words. `tools/feature-map/check.mjs` (in `bun run lint`) fails when a
  path or heading there matches nothing: fix the entry in the change that moves the code.
- Keep gateways opt-in, subscription credentials isolated, helper context consent separate per
  provider and scope, and approval and ownership boundaries intact.
- Keep personal infrastructure, private hosts and repositories, recorded private data and
  corporate defaults out of the tree. Fixtures are synthetic and set provider, auth and CLI
  state explicitly; they never inherit the host's GitHub login or a paid account.
- Never read `.env` files, key files or credential stores (`.claude/settings.json` denies them),
  and never put secrets, environment dumps or boot URLs in logs, commits or PRs.
- Preserve exact dependency pins, the workspace catalog, native overrides and the Effect patch
  unless the task needs a change.
- Run `bun run check:scaffold` and the relevant checks from the
  [verification matrix](docs/VERIFICATION.md#task-verification-matrix). Focused checks while
  iterating; `bun run check` is the full integration check.
- Stop only what you started: `bun run check:cancel`, Ctrl-C or the exact PIDs. The Bash guard
  ([guard-bash](tools/agent-guards/guard-bash.mjs)) refuses `pkill`, `killall` and `kill` on `pgrep`.
- Rules live in checks. When you catch a mistake that could recur, yours or another agent's,
  prefer a type, lint rule, import boundary or test to a new line here; give the check a message
  that names the fix, and clear its existing violations in the same change. See
  [rules live in checks](CONTRIBUTING.md#rules-live-in-checks).
- Fix demonstrated causes, with a before/after reproduction where feasible. Never weaken
  assertions, skips, timeouts or permission guards to get a pass. Claim only what was tested:
  synthetic success is not live-provider qualification.
- A test earns its place by guarding behaviour that could break and that someone would mind.
  Don't test wording (prompts, skills, tool descriptions, UI copy), mirrors of the implementation
  or the same thing at two layers; never cut security, approvals, egress, migrations, data loss,
  the API/MCP contract or the merge and release paths. See
  [what earns a test](docs/VERIFICATION.md#what-earns-a-test).
- Use 24-hour times in product UI and documentation; `gram/clock-24h` holds the web app to it.
- For a UI change whose look is open, follow [DESIGN.md](DESIGN.md) and the
  [mock-first playbook](docs/orchestration/playbooks/mock-first.md); most tasks skip the mock.
- Gram's web app is also mounted inside other apps, which ship a pinned commit of it. When a
  change removes, renames or re-words something they can see (a screen, a mount option, a kit
  control, a theme name, a `data-testid`), follow
  [keeping embedders in step](docs/EMBEDDED_WEB_APP.md#keeping-embedders-in-step).
- Push a feature branch, never `main` (the Bash guard refuses it), and open a PR with a
  conventional title (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`). Put commands,
  results and known limits in the PR description.
- Risky, cross-cutting or security-sensitive changes get an independent review of the current
  head before they merge; see [contributing](CONTRIBUTING.md#security-sensitive-changes).
