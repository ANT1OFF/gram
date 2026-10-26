# Gram design notes

[Up: Gram README](README.md) · [Mock-first playbook](docs/orchestration/playbooks/mock-first.md)

What an agent needs to know to draw something that looks like Gram, before a mock or a UI change.
The theme stylesheet is the source of truth; this page explains it and the habits around it.

## Look

- **One look: Glass.** Translucent chrome over a faint accent wash, soft layered shadows on raised
  and overlay surfaces, and a hairline where a surface needs an edge. Palettes are the user's
  choice; design against the Neutral palettes (`neutral`, `neutral-dark`) and check the others
  don't break.
- **Type: Inter** for the interface and **JetBrains Mono** for code, paths, hashes and numbers that
  line up. Regular weight for text, semibold for titles and emphasis.
- **Colour from tokens only.** Surfaces `surface-1` (chrome) to `surface-3` (raised), text `fg`,
  `fg-muted`, `fg-subtle`, borders `border-subtle` and `border-strong`, one `accent` for the
  primary action and the current place, and status colours (`danger`, `success`, `warning`,
  `info`, `status-needs`, `status-working`, `merged`) only where they mean that status.
- **Radii are soft:** 8 to 16 px (`radius-xs` to `radius-xl`); the composer is rounder (22 px).
- **Rows:** 36 px by default (`--row-comfortable`), 30 px in compact density (`--row-compact`).
  Lists, menus and the sidebar share one row shape.
- **Icons: Lucide** at a 1.75 stroke, 16 px in rows and buttons, never as decoration and never
  emoji.
- **Motion is short and springy:** 220 to 320 ms with the theme's ease-out, springs for presses
  and arrivals, and none under reduced motion.

## Voice

- Plain and short. Sentence case. Buttons are verbs ("Create branch", "Open PR").
- Say what happened and what the user can do; no blame, no exclamation marks.
- Times are 24-hour (`17:05`, `Yesterday 09:42`). Durations in the largest sensible unit.
- No invented data in docs or mocks: real names from the code, or a bracketed gap such as
  `[Workspace name]`.

## Not Gram

Gradients and glows; emoji as icons; cards with a coloured left border; everything in a card; a
second accent colour; hex colours instead of tokens; centred layouts for app screens; drawn device
status bars.

## Where it lives

- Theme source: `@gram/themes` generates
  [themes.css](apps/web/src/styles/generated/themes.css) (regenerate with `bun run test -u`).
- Components: [apps/web/src/components/ui](apps/web/src/components/ui/) (alert, badge, button,
  button group, collapsible, context menu, select, switch, tabs and tooltip).
- Mock tokens: [docs/design/mocks/tokens.css](docs/design/mocks/tokens.css), generated from the
  theme by `bun run mocks:tokens` and checked by the tests, so a mock wears the same palette.
- Mock skills: [design-brief](.agents/skills/design-brief/SKILL.md),
  [mock-build](.agents/skills/mock-build/SKILL.md) and
  [mock-review](.agents/skills/mock-review/SKILL.md); the loop is in the
  [mock-first playbook](docs/orchestration/playbooks/mock-first.md).
