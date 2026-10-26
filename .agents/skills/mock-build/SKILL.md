---
name: mock-build
description: Build or revise a local HTML mock of a UI before implementing it, using the workspace's own theme tokens and the mock kit. Use after design-brief, or whenever asked for a mock, mockup, wireframe, prototype or directions.
---

# Mock build

A mock is a folder of plain HTML pages, one per version, drawn with the workspace's own tokens
and this skill's kit, and opened beside the conversation. It runs with any model and any harness:
no network, no build step, no service.

## The folder

```
docs/design/mocks/
  tokens.config.json   which theme file and selectors the tokens come from
  tokens.css           generated from the theme; never edited by hand
  <slug>/
    mock.json          title, status, versions, approved version (kept by new-mock.mjs)
    brief.md           from design-brief
    decisions.md       one line per review round (mock-review)
    kit/               tokens.css, kit.css, kit.js, copied when the mock was made
    shots/             a screenshot per direction and theme (local only, never committed)
    v1.html  v2.html   one page per version, never edited once reviewed
```

Each mock carries its own `kit/` copy because the preview serves only the page's folder and what
is beneath it, and so an older mock keeps the look it was reviewed with. A workspace without
`docs/design/mocks/tokens.css` gets the kit's fallback (Gram's neutral palette); pass `--root` to
put mocks elsewhere.

## Steps

1. **Tokens.** If the workspace has a `tokens.config.json`, check the tokens are current:
   `node .agents/skills/mock-build/scripts/mock-tokens.mjs docs/design/mocks/tokens.config.json --check`,
   and regenerate without `--check` when stale. For a new workspace, write the config (theme file,
   `light`/`dark` selectors, fonts, and a `map` for tokens the theme names differently) and run it.
2. **Scaffold.** `node .agents/skills/mock-build/scripts/new-mock.mjs <slug> --title "…" --template <name>`.
   Templates: `app-screen` (one screen in its states), `flow` (linked steps), `options`
   (two to four directions), `components` (variants and states), `landing` (a page, desktop and
   phone). It writes `kit/`, `mock.json`, `brief.md` and `decisions.md`, never the page.
3. **Write the page with the Write tool.** Read the template it names, then Write `<slug>/v1.html`
   from it, replacing every bracketed placeholder with real content or keeping it as a visible
   gap. Use the Write tool, not a shell redirect or a script: in Claude, a file written that way
   appears in the workspace's Files view under this feature, where the user finds every version.
4. **Screenshot it.** Save each direction's board in dark and light to `shots/`, named
   `<direction>-dark.png` and `<direction>-light.png`, at the board's size. To give a direction its
   board, add it to `mock.json` (new-mock.mjs keeps it):
   `"directions": [{ "name": "C Hybrid", "board": "c-hybrid-popover", "shots": { "dark": "shots/c-popover-dark.png", "light": "shots/c-popover-light.png" } }]`.
   A board's id is its `data-name` slugged (`C Hybrid · popover` is `c-hybrid-popover`).
   Screenshots stay local: `.gitignore` keeps `shots/` out of commits, and a committed image that
   no Markdown file embeds fails `bun run check:scaffold`. Pictures for a pull request go in its
   body.
5. **Show it as pictures, never as a bare path.** Call `show_mock` with the mock's folder (or its
   `mock.json`): the reply gets a card with the title, the version, a thumbnail per direction with
   a dark/light switch, and Open in Preview. To open a board yourself, `show_panel` with
   `panel: "preview"` and `<absolute page path>#<board id>`. Without these tools (another
   harness), send the screenshots as images and then the page's path.
6. **Say what to look at** in two or three lines: what the version shows, the decision it asks
   for, and the assumptions it makes. For directions, name each and its trade-off here, not on
   the board. When the user is to pick a direction, ask it with your question tool
   (`ask_question` in a worker, `ask_user` in an orchestrator): one option per direction, each
   with its `image` (a screenshot from `shots/`) and its `preview` (`v1.html#<board id>`), and
   the mock in `mock`. The card then shows each option's thumbnail, enlarges it on a click and
   opens the page at that board.

A new version is never an edit of the last: run `new-mock.mjs <slug> --next`, Read the current
version, and Write the next file whole. The bar links every version, so the user can compare.

## The page contract

- Link `kit/tokens.css`, `kit/kit.css` and `kit/kit.js` (deferred), in that order, and nothing
  from the network except the font import tokens.css already has. No frameworks, no CDN scripts.
- `<body class="mock">` holding one `<main class="mock-canvas">` of boards. An optional
  `<p class="mock-note">` first says what to look at.
- A board is `<section class="board" data-name="Name" data-size="1280x800">` with one
  `<div class="board-frame">` inside. `data-size="fill"` makes it page-wide. Names are stable
  across versions: the review refers to them.
- States: `data-states="full,empty,loading,error"` on the board, and `data-when="empty"` (or a
  comma list) on what each state shows. The board strip gets a button per state.
- Links between boards: `<a href="#" data-goto="Board name@state">`. Clicking a board's name opens
  it full window, so a flow can be clicked through; Esc returns.
- Tweaks are levers, not copy: declare at most three in
  `<script type="application/json" id="mock-tweaks">` (`enum`, `boolean`, `color`, `range`). Enums
  and booleans land as `data-tweak-<name>` on `<html>`, colours and ranges as `--tweak-<name>`;
  style against those. The kit already reacts to `density` (`compact`, `comfortable`).
- Icons: `<i data-icon="name"></i>`; the list is `ICONS` in `kit/kit.js`. Add none of your own
  unless the product has them.
- Colour comes only from tokens (`var(--accent)`, `var(--fg-muted)`, the `*-tint` the kit
  derives). A hex value in a mock is a bug.

## Craft

Read [reference/craft.md](reference/craft.md) before the first version of a session. The short
form: real content or marked gaps, never filler; the product's own type and one accent; real
`<button>`, `<a>` and `<label>`; 4.5:1 contrast; layout with flex or grid and `gap`; works at
390 px; no gradients, emoji, glow or left-border cards; no fake status bars or keyboards.

## Checking

Check your own page only when the user asks, or before asking for approval: load it at
1280 px and 390 px, in light and dark, and look for overflow, unreadable text and a state that
shows nothing. Beyond the `shots/` the card needs, don't screenshot every round.
