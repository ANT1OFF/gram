# Spacing and icon audit

[Up: design notes](../../DESIGN.md)

A study for wave 14 of the UI hill climb. After round 11, Gram scored 7.0 on Spacing & density
(the strongest reference 7.75) and 7.0 on Iconography (the strongest 7.5). Two earlier spacing
passes changed padding and rhythm, and neither moved the score. This audit measures Gram's
current tour frames (1728 × 1095 CSS px at 2×) against the strongest reference, C. Each change
it proposes either removes something or changes one system value. No change adds UI.

Measurements are in CSS px, read from 2× captures. They are accurate to about ±1 px.

## What the raters named

- **Spacing.** Three of four raters cited the Docs reader. Its table is squeezed into a nested
  scroll box, wraps in every cell and is clipped at the bottom, under a title that appears twice.
  Raters also called C's settings and search "calmer" and "evenly spaced".
- **Iconography.** Raters praised C for pairing icons with words consistently. In Gram, words
  sit beside glyphs that repeat them, and a few glyphs stand alone. The narrow composer's bare
  bolt and the panel's icon-only inactive tabs were cited. Raters gave B and D lower scores for
  rows of bare glyphs.

## Screen by screen

| Surface            | Gram today                                                                                                                                                               | C                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Icon line          | 16 px Lucide at stroke 1.75: a **1.17 px** line, thinner than Inter's 14–15 px stems (about 1.3 px)                                                                      | One family, about a **1.5 px** line, as heavy as its text                    |
| Icon to label      | 8 px gap; the glyph draws about 13 px of its 16 px box                                                                                                                   | About 14 px; the glyph draws about 16 px                                     |
| Sidebar nav row    | 32–36 px single rows; 48 px two-line rows                                                                                                                                | About 34 px single rows, icon and word                                       |
| Sidebar marks      | Dots for live rows, but Done rows lead with a merge, check or ✕ glyph, so two mark families share one column; "Waiting · checks" adds an hourglass beside the hollow dot | One mark family                                                              |
| Status strip       | Four items, each a glyph and its words ("running", "in review", "merged today", "Since you left")                                                                        | No equivalent; its top bar uses words or glyphs, never both                  |
| Composer toolbar   | Each picker draws an 18 px glyph _and_ its words: gauge + "Effort: High", sparkles + "Mode: Auto"                                                                        | Words only ("Opus 5.5 Medium", "Bypass permissions"), no glyphs              |
| Buttons with words | "Restore defaults", the Docs reader's "Edit" and "Copy Markdown" each lead with a glyph                                                                                  | Words alone, apart from New and Search in the nav                            |
| Settings rows      | 60–64 px two-line rows in raised cards, 24 px between groups                                                                                                             | 53 px flat rows on hairlines; groups about 48 px apart                       |
| Docs reader        | Title shown twice (the header and the doc's own `# Title`); the table in a 300 px scroll box with its own toolbar                                                        | Not matched; its readers show one title and let content scroll with the page |
| Reading column     | 15/24 reading text, 12 px between a reply's blocks, about 60 px between turns                                                                                            | About 15/24, about 24 px between paragraphs, about 66 px between turns       |

The reading column already matches C's rhythm. The gap between turns is the hover-action row
reserved under each message, and C reserves the same space. Changing it would move every
transcript for no gain, so this pass leaves it alone. Settings rows are taller than C's because
they carry a description line that C's rows don't. They stay as they are.

## The changes, most likely to move the score first

1. **One heavier icon line.** `--icon-stroke` goes from 1.75 to 2. Every size token compensates,
   so all icons draw the same 1.33 px line, about as heavy as Inter's stems. The 1.17 px line
   made glyphs look fainter than the words beside them, so each icon read as a separate,
   lighter layer. This is one system value, with no per-icon overrides.
2. **A glyph stands in for words and never repeats them.** The composer's effort, mode and speed
   pickers drop their glyph while their words show ("Effort: High"), and draw it only once the
   row is too narrow for words. The toolbar layout counts this, so the room the glyphs freed
   keeps words showing at narrower widths. The model picker keeps its agent mark, because that
   mark names the agent and the words don't.
3. **The status strip is words only.** "3 running · 1 in review · 6 merged today · Since you left
   2 merged" loses its four glyphs, which only repeated the words beside them.
4. **One mark family in the sidebar.** A Done row leads with its state's dot (`StatusDot`), the
   same dots the live rows use, instead of a merge or check glyph. The waiting line drops its
   hourglass, because the hollow dot and "Waiting · …" already say it. "N more in History"
   drops the History glyph its own words name.
5. **Buttons that say a word drop the glyph that repeats it.** This covers "Restore defaults",
   the Docs reader's "Edit" and "Copy Markdown", and the files-changed row's "Undo". Icon
   buttons without words keep their glyph and tooltip.
6. **The Docs reader reads as one page.** It shows the title once, leaving out the doc's own
   leading `# Title` when it repeats the header. Tables take their full height in the page's
   scroll with no 300 px inner box. They drop the table toolbar, since Copy Markdown already
   copies the whole doc, and the frame that held it: only the table's own edge stays, and its
   cells pad 12 px rather than 16, so a narrow panel wraps them less.

## Considered and left

- **Labelled panel tabs** (cited for iconography): their fit logic belongs to the panel's
  chrome. Folding primary tabs into More by name is a larger change than this pass.
- **The title bar** stays icon-only with text on hover (standing ruling).
- **Settings ⓘ tips:** each one is the only way to reach that setting's longer help.
- **A larger body size:** C's UI text is about 15 px and Gram's 14 px. Changing the type scale
  would affect every surface, and typography already scores at or above every reference.
