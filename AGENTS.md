# Working on Gram

Gram is a desktop app for individual developers who run their own installed Claude Code and
Codex CLIs on their own subscriptions. [README](README.md) introduces it,
[contributing](CONTRIBUTING.md) covers branches, checks and pull requests, and the
[docs map](docs/README.md) leads to the rest.

- Keep gateways opt-in, subscription credentials isolated, helper context consent separate per
  provider and scope, and approval and ownership boundaries intact.
- Keep personal infrastructure, private hosts and repositories, recorded private data and
  corporate defaults out of the tree. Fixtures are synthetic and set provider, auth and CLI
  state explicitly; they never inherit the host's GitHub login or a paid account.
- Never read `.env` files, key files or credential stores, and never put secrets, environment
  dumps or boot URLs in logs, commits or PRs.
- Preserve exact dependency pins, the workspace catalog, native overrides and the Effect patch
  unless the task needs a change.
- Run `bun run check:scaffold` and the relevant checks from the
  [verification matrix](docs/VERIFICATION.md#task-verification-matrix). Focused checks while
  iterating; `bun run check` is the full integration check.
- Never stop processes by pattern (`pkill -f`, `killall`, or `kill` on `pgrep` matches): other
  checkouts may share the machine. Stop your own check with `bun run check:cancel`, or kill only
  the exact PIDs your command started.
- Fix demonstrated causes, with a before/after reproduction where feasible. Never weaken
  assertions, skips, timeouts or permission guards to get a pass. Claim only what was tested:
  synthetic success is not live-provider qualification.
- Use 24-hour times in product UI and documentation.
- For a UI change whose look is open, follow [DESIGN.md](DESIGN.md) and the
  [mock-first playbook](docs/orchestration/playbooks/mock-first.md); most tasks skip the mock.
- Never push directly to `main`, including force pushes. Push a feature branch and open a PR
  with a conventional title (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`). Put
  commands, results and known limits in the PR description.
- Risky, cross-cutting or security-sensitive changes get an independent review of the current
  head before they merge; see [contributing](CONTRIBUTING.md#security-sensitive-changes).
