# Offline agent scenarios

[Up: agent architecture](../../ARCHITECTURE.md) · [Testing](../../../../docs/VERIFICATION.md)

Run `node packages/agents/scripts/generate-fixtures.mjs` from the repository root.
This is the canonical entry point for the Claude scenarios and three invented errors. It reads only checked-in scenario definitions and writes the
corresponding fixtures. It never invokes an agent CLI/SDK, accesses account
configuration, or calls a provider. The scripted Codex and executable child inputs have their own owners.

Each JSONL source line defines one output row. A literal row is emitted unchanged.
`{"copy": N, "set": [[path, value]], "remove": [path]}` copies an earlier output
row, removes the named paths, then sets the named paths. Optional
`link: [[path, N, fromPath]]` copies a field from an earlier row before those edits;
Paths are arrays of object keys. Copying avoids duplicating large initialization frames; it does **not** deduplicate the emitted event stream. Edit these sources,
then regenerate, rather than changing generated fixture files alone.

The identities, paths, reasoning, prose and connector/plugin metadata are invented. Tiny chosen commands, questions, codewords,
colours and image payloads are deliberate scenario inputs. Public Claude model
identifiers exercise model rates/context accounting; their presence does not claim a
developer's model availability or entitlement. Numeric usage/cost/timing values and SDK
event topology are test inputs, not current pricing or performance measurements.

| Sources                      | Behavior retained                                                                                                                     | Consumers                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Claude p01–p04, p08–p09, p11 | Init, streaming/full-message deduplication, state flag, queued/immediate inputs, interruption, resume/fork identities, hook isolation | Agents mapper/session                                  |
| Claude p05 variants, p06–p07 | Setting sources/destinations, paths, approval suggestions, plan approval, questions, rejection                                        | Agents mapper/permissions/sessions; contracts domain   |
| Claude p12                   | Explore child tools/usage, launch result, parent idle, child completion and second parent turn                                        | Agents mapper/sessions; web background mock/task strip |
| Claude p13                   | Invented checkerboard in structured image and SDK tool-result forms                                                                   | Agents mapper                                          |
| Claude p14                   | Two shells, list-before-start, stopTask, completion between turns, later report                                                       | Agents mapper; server runtime replay; web task strip   |
| Claude p16                   | Compaction hooks, excluded analysis, retained summary and before/after occupancy                                                      | Agents mapper                                          |

Identity mappings preserve equality and inequality across messages, tool calls, requests,
tasks, parent/child lanes, notes and multiple files. Tests keep exact paths/IDs as invented
constants, and compaction's negative assertion names the invented analysis text it must strip.
Codex cx06/cx08/cx10 are consumed by the server's dynamic runtime replay (two/two/one turns),
with their scripted recorder scenarios. These tests qualify offline replay semantics, not real
account access, future CLI versions or exhaustive confidentiality.
