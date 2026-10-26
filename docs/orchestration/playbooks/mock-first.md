# Mock first

[Up: design notes](../../../DESIGN.md) · [Mocks folder](../../design/mocks/README.md)

How a UI change goes through a reviewed mock before code, and how an orchestrator runs that as
stages. Most tasks skip it: the mock is an opt-in stage for changes whose look someone could
disagree with. The steps are three skills any harness can load from `.agents/skills/` (Claude
finds them through `.claude/skills/`):
[design-brief](../../../.agents/skills/design-brief/SKILL.md),
[mock-build](../../../.agents/skills/mock-build/SKILL.md) and
[mock-review](../../../.agents/skills/mock-review/SKILL.md).

## Triage

| The task                                                        | Mock?                    |
| --------------------------------------------------------------- | ------------------------ |
| New screen, view, panel, page or multi-step flow                | Yes                      |
| New states users will meet (empty, error, loading, permission)  | Yes                      |
| New control or layout whose look is the point                   | Yes, often as directions |
| User asked to see it first, or the brief leaves the look open   | Yes                      |
| Another row, setting or item in an existing pattern             | No                       |
| Fix, refactor, copy, dependency, backend or anything without UI | No                       |
| The user gave a picture or exact instructions                   | No; build from those     |
| A one-line visual fix with an obvious result                    | No; show a screenshot    |

When in doubt, skip it and say so; a mock can be added when the first build draws comments.

## In one thread

1. **Brief** (design-brief): ground in the code and `DESIGN.md`, ask once if two or more
   result-changing decisions are open, scaffold the folder and write `brief.md`.
2. **Build** (mock-build): write `v1.html` with the Write tool, screenshot each direction to the
   local `shots/` in dark and light, and present it with `show_mock`: a card with the title, version,
   a thumbnail per direction and Open in Preview. Directions first when the shape is open, and
   the question that picks one carries them: each option's `image` and `preview`
   (`v1.html#<board id>`), and the mock in `mock`. Never present a mock as a bare path.
3. **Review** (mock-review): each comment becomes a new version with a line in `decisions.md`,
   until the user approves; then `handoff.md`.
4. **Implement** from `handoff.md` and the approved page, in the same branch or a new one.
5. **Compare** when asked: the approved page beside the running app, differences by board.

Every version, brief and handoff is written with the Write tool, so the workspace's Files view
lists them under the feature, and the user can reopen any version from there. Screenshots stay
local: they are for the cards, and pictures for a pull request go in its body.

## With an orchestrator

A feature that needs a mock gets a stage plan, so the board shows where it stands:

```
set_stage feature=<feature> plan=["mock", "approved", "build", "compare", "merged"] stage="mock"
```

1. **mock**: `spawn_worker` with a brief that names the mock skills, the mock's slug and
   `docs/design/mocks/<slug>/` as its `scope`, and says no app code. The worker opens a
   docs-only PR with the mock folder (without `shots/`), so the mock is reviewable.
2. When the worker reports a version ready, the review is the user's. Relay the mock with
   `show_mock` on the worker's mock folder (its worktree is under your repo), so the user sees
   the card, not a path. An open review is a `wait_on_user` review naming what to decide. A pick
   between directions is an `ask_user` question with the mock attached: one option per
   direction, each with its `image` (from the mock's `shots/`) and `preview`
   (`v1.html#<board id>`), and `mock` (its `mock.json`); the card shows the thumbnails, enlarges
   them and opens each in Preview. Their comments go back to the same worker, which runs
   mock-review rounds.
3. **approved**: once the user approves and `handoff.md` is in the mock PR, set the stage.
   Merge the mock PR with the build, or close it once the build has merged.
4. **build**: spawn the implementing worker with the handoff and the approved page named in its
   brief. If the mock PR isn't merged yet, give the mock worker in `readAlso` so the builder can
   read its worktree, and declare the mock PR with `depends_on` so the build PR waits for it. A deviation from the mock is a line in `decisions.md` in the build PR,
   not a silent change; a large one goes back to the user.
5. **compare**: when the build PR is green, ask the worker (or a fresh one) to compare the
   running app with the approved page per mock-review, and fix what is missing in the build.
6. **merged**: as usual.

Features without a mock keep their usual plan; don't add a mock stage to make the board uniform.

## Limits

- Mocks are local HTML only: no sharing, no hosting, no network beyond the font import.
- Pictures and pages show only from the asking thread's own worktree or repo; a path outside it
  is refused when the question is asked or the card is made. Preview stays loopback-only.
- The kit draws Gram's Glass look with the Neutral palettes; other palettes are a product check
  after the build, not a mock concern.
- Compare is manual: a side-by-side review, not a pixel diff.
