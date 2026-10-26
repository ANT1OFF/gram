---
name: design-brief
description: Decide whether a task needs a mock before code, and if so write its brief and pick directions. Use when a task changes what a user sees (a screen, a flow, a control, a page) or the user asks to design, mock or sketch something first.
---

# Design brief

The first step of the mock-first loop: decide whether to mock at all, gather what the mock needs,
and settle the open decisions before anything is drawn. The next steps are
[mock-build](../mock-build/SKILL.md) and [mock-review](../mock-review/SKILL.md); the whole loop
and how it fits a workspace's orchestrator is in `docs/orchestration/playbooks/mock-first.md`
when the repository has it.

## 1. Triage: does this need a mock?

Mock when the change has a visible shape someone could disagree with:

- a new screen, view, panel or page;
- a flow of more than one step, or a new state (empty, error, loading, permission) that a user
  will meet;
- a control or layout change whose look is the point (a new menu, card, toolbar, dialog);
- the user asked to see it first, or the brief leaves the look open.

Skip the mock and build directly when:

- the change is a fix, a refactor, copy, a dependency or anything without UI;
- it reuses an existing pattern exactly (another row in an existing list, another setting in an
  existing form);
- the user already gave a picture, a mock or exact instructions;
- it is a one-line visual fix whose result is obvious from the description.

When unsure, say which way you went and why in one line, and go. A skipped mock costs nothing to
add later; an unwanted one costs a review round.

## 2. Ground it

Read before asking. A mock built on guesses gets thrown away.

- The workspace's design notes: `DESIGN.md` at the root if present, then the theme the kit's
  tokens come from (`docs/design/mocks/tokens.config.json` names it).
- The real code of the screens this touches, and the components it would use. Hi-fi work starts
  from what exists: the mock should look like the product, not like a new product.
- Earlier mocks for the same area in `docs/design/mocks/`, and their `decisions.md`.

## 3. Ask once, only if it matters

Ask the user only when two or more decisions that change the result are open and the code and
notes can't settle them. Then ask once: at most four questions, each answerable in a word, each
with your default marked. Otherwise pick the reasonable default, write it into the brief as an
assumption, and go. Never ask about things a mock answers better by showing (colours, spacing,
which layout looks right): those become directions or tweaks.

## 4. Directions first when the shape is open

When the layout itself is the open question, the first version is two to four genuinely different
low-fidelity directions on one page (template `options`), not one polished guess. Different means
a different structure (inline vs a side panel vs a separate view), not the same layout in two
colours. Give each a stable name ("A Inline", "B Panel") that the review can pick by, and use it
as the board's name, so its id, its screenshots in `shots/` and the question's options all match.
The trade-offs go in your reply, not on the boards. The question that picks one carries the
pictures: each option's screenshot and board, and the mock (mock-build, step 6), never a path in
the context.

When the shape is already settled (an existing pattern, or the user described it), go straight to
one hi-fi screen or flow.

## 5. Write the brief

Scaffold the mock folder (see mock-build), then fill its `brief.md` with the Write tool. Keep it
under a screen:

- **Problem**: what the user can't do or finds hard today, in their words.
- **Who and where**: who meets this and from which screen.
- **Must show**: the states and facts the mock has to cover (real names, real numbers from the
  code or the user; anything unknown stays a bracketed gap such as `[YOUR PRICE]`).
- **Out of scope**: what this mock deliberately leaves alone.
- **Open questions**: the assumptions you made, each with the default you picked.

Then hand on to mock-build with the template the triage chose.
