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
- **One meaning per status colour.**
  - Amber is "needs you" (an approval, a question, an ask) and nothing else: `status-needs` for its
    words, `status-needs-mark` for its dots, icons and borders. It outlines on a neutral fill,
    never a tinted one.
  - Working and running take `status-working` (the accent), failing `danger`, done `success` or
    muted, and merged `merged`.
  - Informational marks (a PR waiting on review, a paused workspace, a held brief) stay neutral
    or outlined.
  - An orchestrator's sidebar line carries at most one amber marker, its count; its workers'
    rows say "asks you" in plain text.
  - `warning` is for a caution on a setting the user chose: Bypass (amber with its lock, on
    purpose), Full autonomy, a key clash, and the usage meter from 90% of a limit (red once
    spent with no credits).
- **Radii are soft:** 8 to 16 px (`radius-xs` to `radius-xl`); the composer is rounder (22 px);
  small marks (a key cap, a bar, a swatch) take 4 px (`radius-2xs`).
- **Rows:** 36 px by default (`--row-comfortable`), 30 px in compact density (`--row-compact`).
  Lists, menus and the sidebar share one row shape.
- **Spacing is on a 4 px step:** 4 or 8 px inside a row or card, 8 px between cards, 12 px
  around a list's rows and headings, 16 px between sections and at a pane's edges.
- **Settings descriptions** (a setting's or a group's line under its name) are `text-body` in
  `text-description` (`--fg-description`, a step nearer `fg` than `fg-muted`), no wider than
  `--description-measure`; a settings segment is a full 32 px target (`SEGMENT_ROOMY`).
- **Titles and metadata:** a title at 13 to 14 px in `fg` (`text-body-strong` or `text-reading`),
  its metadata (where it is from, its state, a time or a count) at 12 px in `fg-muted`
  (`text-meta`), never smaller. A title wraps to two lines before it is cut short. Metadata a
  heading or the whole list already says is left out: no repo on each row when every row has the
  same one, no workspace under its own heading.
- **Key hints** inside a button are a key cap in the button's own text colour (`KEY_CAP`,
  `ShortcutKbd cap`), never a faded one; elsewhere a hint goes in the tooltip.
- **The reading column** (`thread-column`) is as wide as Settings → Appearance → Reading says and
  leans toward the sidebar in a wide pane (`--thread-lean`, 0.5 centres it). Memory's rendered
  files use it too; Settings' pages take `settings-column` (60 rem, leaning `--settings-lean`).
  The sidebar keeps the width the user gives it, and its edge shows a grip while the pointer is
  over the column.
- **Icons: Lucide** at a 1.75 stroke, never as decoration and never emoji. Two sizes: 16 px in
  chrome (the title bar, the sidebar's header, the panel's tabs and the composer's toolbar) and
  14 px inline (rows, chips, cards, menus and docks). A disclosure chevron beside a glyph or a
  value, and a menu's check, are inline glyphs (14 px) wherever they sit.
  - An icon button is at least 28 px square (`icon-sm` for chrome, `icon-xs` inline), with a
    background on hover and focus. Its tooltip names it and its shortcut at once, and its
    accessible name says the same; a `title` on an icon `Button` becomes that tooltip. Its hover
    and open fill is `bg-accent` (`surface-hover`), the row hover's, so the target shows in dark.
  - Chrome glyphs are `fg-muted` until hovered, focused or open, in the title bar's slot too (a
    thread's role glyph, Keep beside); colour on a glyph is a status it means, never decoration.
  - The open tab, view or toggle shows a background or an underline, never colour alone.
  - One meaning per glyph, and one glyph per meaning: the Inbox (everything that needs you) is
    `Inbox`, a needs-you mark or count `Hand`, review `Eye`, take over `HandGrab`, a question `MessageCircleQuestion`, an approval
    `ShieldQuestion`, a plan `ListChecks`, effort the gauge, usage and limits
    `ChartNoAxesCombined`, Board `Columns3`, the orchestrator `Network`, a worker `Workflow`,
    Dreams `MoonStar`, Quiet `Moon`, Terminal `SquareTerminal`.
- **One selection and focus style.**
  - The row the pointer or the arrow keys are on, in every menu, list, the palette and History,
    takes `row-cursor`: a fill and an accent bar at its start.
  - A chosen value (a card, a segment, a setting, a repository) takes `choice-selected`, an
    accent-tinted fill and edge, with a check where it has room; never colour alone. A menu's
    current value is its check.
  - Keyboard focus is the `focus-ring` outline (`--focus-ring`, `--focus-width`); a menu, list or
    dialog never rings as a whole.
- **The composer's toolbar says its values while it has room:** the model's name, then effort
  and mode in a word or two beside their glyphs ("Extra high", "Plan"), giving way to glyphs alone
  from the right as the row narrows, then folding into "…". Each trigger's tooltip and name say
  the value and its shortcut ("Effort: Extra high (⌘⇧E)"), its open list checks the current
  value with a line on what each costs, and a pick is confirmed in words for a moment. Every
  target on the row is 32 px tall. Stop is a solid disc inside the running ring, and its key
  shows beside it while the composer has focus.
- **The title bar is icon-only and few:** the workspace, Chat · Board and the thread's title, then
  what wants you (a paused workspace, usage, the bell), one "…" with everything else in words and
  shortcuts, and the panel. A new control goes in the "…" unless it is needed at a glance.
- **Motion is short and springy:** 220 to 320 ms with the theme's ease-out, springs for presses
  and arrivals, and none under reduced motion.

## Tokens

Every size, space, radius, shadow and colour in `apps/web/src` comes from a token. The type scale
and radii are per look in [`@gram/themes`](packages/themes/src/looks.ts); spacing, elevation and
selection are in [globals.css](apps/web/src/styles/globals.css) and
[tokens.css](apps/web/src/styles/tokens.css).

**Type scale.** Seven steps, each with its line height; three carry a default weight that a
`font-*` class can still override.

| Class              | Size / line | Weight   | For                                                          |
| ------------------ | ----------- | -------- | ------------------------------------------------------------ |
| `text-caption`     | 11 / 16 px  | inherits | Counts, badges, key caps, overline labels. Never prose.      |
| `text-meta`        | 12 / 16 px  | inherits | Metadata, help text, chips, a row's second line.             |
| `text-body`        | 13 / 20 px  | inherits | UI text: rows, menus, buttons, labels, settings.             |
| `text-body-strong` | 13 / 20 px  | 500      | A row's or card's title; an emphasised label.                |
| `text-reading`     | 14 / 20 px  | inherits | Content: messages, descriptions, inputs, a dialog's body.    |
| `text-title`       | 16 / 24 px  | 600      | Dialog, pane and section titles.                             |
| `text-heading`     | 20 / 28 px  | 600      | A page's heading (a Settings page, an empty state, Welcome). |

Markdown in the transcript keeps its own scale, sized by Settings → Appearance → Reading.

**Spacing.** Tailwind's numeric steps are 4 px (`p-1` is 4 px, `p-4` 16 px); stay on whole steps,
with half steps (`0.5`, `1.5`) only to centre something optically inside a control. Named steps
say what the space is for: `tight` 4 px (an icon and its label), `inset` 8 px (inside a row or
card, between cards), `list` 12 px (around a list's rows and headings), `section` 16 px (between
sections, at a pane's edges), as in `gap-inset` or `px-section`.

**Radius.** `rounded-2xs` 4 px, `rounded-xs` 8, `rounded-sm` 12, `rounded-md` 14, `rounded-lg`
and `rounded-xl` 16, `rounded-full` for pills and dots, and `--composer-radius` for the composer.

**Elevation.** One step for every secondary surface: a card, a panel's block, a popover and a menu
take `bg-card` or `bg-popover` (both `--surface-raised`, which is `surface-3`: the palettes hold
muted text at AA there) and the edge `border-edge`, which carries the step in dark where a shadow
doesn't show; a row that opens or acts (a tool row, an update, the files-changed row) takes the
firmer `border-edge-action`. A plain divider stays `border-border`. `shadow-raised` for a card on a surface, `shadow-overlay` for what
floats (a menu, a popover, a toast), `shadow-modal` for a modal dialog over the scrim (History, a
confirm), `shadow-composer` for the composer slab. The scrim dims toward the chrome surface, more
in light (82%) than dark (60%), so the page behind a light dialog doesn't compete with it. More
contrast and forced colours turn the shadows off and the edges to `border-strong`.

**Selection and focus.** The `row-cursor`, `choice-selected`, `focus-ring` and
`focus-ring-inset` utilities in globals.css, as described under Look. In the sidebar the open
thread's row (a worker, a solo thread, a Done row) takes `choice-selected` (`CURRENT_ROW`), and its
workspace's line the quieter `bg-sidebar-row-active`, so the deepest current place reads strongest.

**The drift check.** `node tools/design-tokens/check.mjs` (part of `bun run lint`) flags in
`apps/web/src`: text sizes outside the scale (`text-xs`, `text-[13px]`), raw arbitrary spacing
(`p-[7px]`), raw radii (`rounded-[6px]`, Tailwind's literal `rounded`), Tailwind's own shadows
(`shadow-md`), and colours that skip the palette (`#hex`, `bg-[rgb(…)]`, `bg-black/75`).
Arbitrary values built from tokens (`pl-[max(--spacing(2),var(--x))]`) pass. Existing uses are
counted per file in [its allowlist](tools/design-tokens/allowlist.json), which only shrinks: move
a file onto the tokens, then run the check with `--write` to record it. Its `mode` is `error`, so
the check fails `bun run lint` on any new use; an allowlist entry is for a deliberate exception.

## Voice

- Plain and short. Sentence case. Buttons are verbs ("Create branch", "Open PR").
- Say what happened and what the user can do; no blame, no exclamation marks.
- Times are 24-hour only, from `formatStamp` in `apps/web/src/lib/time.ts`: `HH:MM` today
  (`09:42`, `00:00`), else `D Mon HH:MM` (`14 Jun 08:00`), with the year only when it isn't this
  one's (`14 Jun 2025 08:00`). A date alone, for a day heading or a date column, is `D Mon`
  (`formatDay`). No US order and no weekday, except a pending wake's chip (`Fri 14:30`, at most a
  week ahead). Relative times (`5m ago`) stay; durations in the largest sensible unit.
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
