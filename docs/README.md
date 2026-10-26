# Documentation map

[Up: Gram README](../README.md)

The root README is the entry point. Each topic below owns its facts; other pages link to it
rather than repeat it.

| Topic                                         | Detailed children                                                                                      | What belongs here                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [Development](DEVELOPMENT.md)                 | [Testing](VERIFICATION.md), [acceptance](development/ACCEPTANCE.md), [remote access](REMOTE_ACCESS.md) | Toolchain, install/run setup, check commands and acceptance procedure |
| [Contributing](../CONTRIBUTING.md)            | [AGENTS.md](../AGENTS.md)                                                                              | Branches, pull requests, reviews and merging                          |
| [Agents and features](AGENTS_AND_FEATURES.md) | [Settings by chat](design/settings-by-chat.md), [worker questions](design/worker-questions.md)         | Provider selection, context consent, capability and permission limits |
| [Architecture](ARCHITECTURE.md)               | Linked package/service implementation                                                                  | Dependency direction and state ownership                              |
| [Releasing](RELEASING.md)                     | [Updates](UPDATES.md)                                                                                  | Versions, signing, building and publishing releases                   |
| [Design notes](../DESIGN.md)                  | [Mock-first playbook](orchestration/playbooks/mock-first.md), [mocks](design/mocks/README.md)          | Gram's look and voice, mock skills and the mock folder convention     |
| [Public readiness](PUBLIC_RELEASE.md)         | [Acceptance](development/ACCEPTANCE.md)                                                                | Security boundaries and what is not yet qualified                     |

Versions come from the version files and manifests; guides explain what they mean. Results of a
particular change belong in its pull request, not in the docs. Package-local
[agent architecture](../packages/agents/ARCHITECTURE.md),
[offline scenario ownership](../packages/agents/scripts/scenarios/README.md),
[app icons](../apps/desktop/assets/README.md),
[review fixture guidance](../packages/git/src/fixtures/review-bot/README.md) and
[third-party notices](../apps/web/src/motion/THIRD-PARTY-NOTICES.md) stay beside the assets they
describe.
