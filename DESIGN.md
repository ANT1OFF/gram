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
- **Colour that says whose it is.** Beside the status colours, two marks carry a colour of their
  own, on the glyph alone, never a fill, a pill or a row:
  - An agent's mark wears its provider's brand colour wherever it is drawn (`AgentIcon`):
    `provider-anthropic`, Claude's orange, and `provider-openai`, white on dark and near-black on
    light. No palette seeds them, so a provider looks the same in every theme.
  - The orchestrator's glyph (`Network`) takes `orchestrator`, the palette's second accent
    (`highlight`), on its role glyph and chip, its update's card, a workspace in a picker and the
    New form's Team (`ROLE_TONE`). A worker's glyph stays in the colour around it.
- **One meaning per status colour.**
  - Amber is "needs you" (an approval, a question, an ask) and nothing else: `status-needs` for its
    words, `status-needs-mark` for its dots, icons and borders. It outlines on a neutral fill,
    never a tinted one.
  - Working and running take `status-working` (the accent), failing `danger`, done `success` or
    muted, and merged `merged`.
  - Informational marks (a PR waiting on review, a paused workspace, a held brief) stay neutral
    or outlined. A file's type, a pending check, a stale stage and a caution that isn't one of
    `warning`'s cases below are neutral too: the glyph's shape says it, not a status colour.
  - **Progress is grey.** A stage or progress bar draws the steps behind in grey and the step it
    stands on in the accent (the current place), never in the worker's status colour: the status
    is the dot and words beside it.
  - **A pull request stays quiet:** its chip or link is muted words in a neutral or outlined box,
    and the colour is on its glyphs only (merged on the state glyph, red on a failing check's), so a
    failing or merged PR adds one coloured mark, not a tinted pill or a second red line.
  - An orchestrator's sidebar line carries at most one amber marker, its count; a worker that
    needs you takes the amber dot like everywhere else, and its row says "asks you".
  - **One dot per state, and few states**, the same in the sidebar, on the Board and in Workers
    (`StatusDot`): amber needs you, the accent is running and pulses, a hollow accent ring is
    waiting on something outside it (checks, a review, a wake, a usage limit), grey has stopped,
    the merged colour is done, and red failed. The row beside a dot says at its edge what the dot
    can't, as a wait's reason ("checks"), and the dot's hover says what its colour or fill
    means ("Hollow: waiting on checks, a review, a wake or a limit"), so the dots need no legend.
    A PR's pending checks, queued or running, and a review bot's round under way take the same
    hollow ring as a glyph (`PendingRing`), still in every motion setting, wherever they show:
    a wait can last an hour, and only a turn under way turns (`Spinner`, Stop's ring).
  - **One amber in each mode.** The needs-you text and its dots are one hue (`status-needs` is
    `status-needs-mark` darkened to the text floor, never a different colour); the light palettes
    of the Neutral family seed a true amber, not an orange. Words take `status-needs` (AA, 5.5:1 or
    more on every light surface), never the mark token, which is for dots and glyphs only. A
    needs-you pill or count is a neutral outline (`sidebar-block-border`), never an amber ring or
    fill: only its dot and the count of what asks are amber.
  - **One alarm per failure:** the error's card in the transcript and the thread's one red dot.
    Everything else stays neutral: the plan strip, the title bar, a label's chip (named, never
    tinted). The needs-you entry counts errors among what needs you but never tints them: its
    amber dot and words are for what asks ("1 question" amber, "· 1 error" muted), errors alone
    leave it neutral. Its words are the pill's alone (the sidebar's, Settings' strip's, Quiet's):
    with the sidebar hidden the title bar's way in is the Inbox, an icon button in the attention
    group's first slot, one size whatever waits, its corner dot amber while something asks (the
    bar's one amber mark), neutral for errors alone, and the pill's words on hover, never a word
    chip that jumps into the bar or a number on the glyph; the compact rail's count (its number, in a neutral outline) and the
    Board's waiting chip turn amber only while something asks too. A retry that ran through says what was done and how it went
    ("Retried at 14:11 · succeeded"), its failure folded under Details.
  - `warning` is for a caution on a setting the user chose: Bypass (amber with its lock, on
    purpose), Full autonomy, a key clash, and the usage meter from 90% of a limit (red once
    spent with no credits); and for a caution that saving would overwrite work (a file changed
    under an open edit).
- **Radii are soft:** 8 to 16 px (`radius-xs` to `radius-xl`); the composer is rounder (22 px);
  small marks (a key cap, a bar, a swatch) take 4 px (`radius-2xs`).
- **A dialog fits the window:** it opens a fifth of the way down and is never taller than the
  rest of the window less a margin (`DialogShell`). Its actions stay in view: a dialog whose body
  can grow (a form, a list) scrolls that body and keeps its error and buttons pinned below it, so
  a short window never hides Submit.
- **Rows:** 36 px by default (`--row-comfortable`), 30 px in compact density (`--row-compact`).
  Lists, menus and the sidebar share one row shape. Every sidebar row, whatever it lists (a
  workspace, a worker, a solo thread, a PR, a Done item), is one line of one height
  (`--space-row`): its mark (a Done item's is its state's dot, as a worker's is), its title
  (`ROW`, `ROW_TITLE`), and at the right edge what trails it in short muted words (`ROW_TRAIL`,
  never wider than 7 rem): a time, a PR's ref, a workspace's "3 working", or what the dot
  can't say. The title is cut at its end (never its middle) with an ellipsis, and the row's hover
  (its `title`, or a worker's card) says the whole of it and the rest of its state, so a list
  reads as even rows, never one taller than the next. A worker's edge says only what its dot
  can't: an ask ("asks you"), a failure, a wait's reason without "Waiting" (the hollow dot says
  it: "checks on #88", `waitShort`) or "Starting…". The words win: with words at its edge its PR
  chips stay on its hover card. At work, its dot says it all: no words, its PR chips after its
  title only while the whole title fits beside them (else its hover names the PR), and its hover
  card says its plan's step and what it runs. A solo thread's edge says what needs you or failed
  in that colour ("Needs approval"), else when it was last active. A
  worker's agent mark shows only where its workspace's workers run different agents; all on one
  agent, the state dot alone marks each row and the hover names the agent. What needs you is
  listed first.
  - **The sidebar groups by state, in three sections at most:** Orchestrators (the workspaces
    where something runs or asks, and the one in view), Solo threads, and At rest at the end,
    folded until opened (kept across reloads): what needs nothing of you, the workspaces at rest
    (nothing running, nothing asking, no brief held, not the one in view), the pull requests and
    Done, each under a heading with its count. A workspace leaves At rest the moment something
    runs or asks there, and a lone one at rest keeps its row, since folded away alone it would
    only hide its name. Pull requests show only beside work: on an empty home (no workspace, no
    thread) they would stand alone. Done shows the three chats that finished last, solo threads that settled
    on their own included, then "N more in History", which continues the same list on History's
    Done chip. History, at the column's foot ("History", its key on its hover), is old work's one
    way in from the sidebar, and the palette hands a search matching finished threads there too.
    Each workspace folds its workers under its chevron.
  - **Every section's title has one look** (`SECTION_TITLE`), folded or open: its chevron on the
    rows' mark column, its name in muted 13 px words where the rows' titles start, and its count
    in the column at the right edge where the rows' trailing words end; At rest's headings and
    a solo list's Archived and Snoozed folds take the same grid. A Gram word's explanation ("Solo
    threads") is on its hover, never a dotted underline there. Marks centre on one column and
    titles start on one edge, the pill, Search, section titles and History included. The
    overview's sections sit a list's step (12 px) apart.
  - **A thread on another machine says which, and one on this machine says nothing.** The mark
    (`MachineMarker`) is the server glyph and the machine's name in muted meta words, at a sidebar
    row's edge before its other words, after a Workers row's status, under a Board task and first
    among a thread header's chips; never a chip or a pill. Beside words a row's edge already has
    ("asks you", "checks") it is the glyph alone, the name on the row's hover. A machine nothing
    reaches takes the struck glyph and the word ("offline", "needs update") in the text colour,
    never a status colour: the glyph's shape says it, and a turn it failed has its own red dot. Its
    hover says the machine, joined machine or provisioned host, its state, and why and the fix
    when it is offline, as Settings → Machines words them.
  - The compact rail (60 px, under 1280 px) gives each workspace a tile with its monogram, one
    letter of its name ("billing-api" is "B"), two only where workspaces share a first letter
    ("BA", `monograms`), in the tile's own text colour, never a coloured avatar, with its count
    at the corner; the solo threads' tile keeps a thread's glyph. Its flyout opens the moment the
    tile is hovered or focused and heads with the whole name, so a letter is never left to guess;
    the name is in the tile's accessible name too.
- **Spacing is on a 4 px step:** 4 or 8 px inside a row or card, 8 px between cards, 12 px
  around a list's rows and headings and between a reply's blocks, 16 px between sections and at a
  pane's edges. A settings row takes 8 px above and below, and a page's groups sit 24 px apart
  (`SETTINGS_STACK`) on every page. A table fills its pane (the Board's grid): a column of fixed
  content (a stage bar, a date) keeps its width and the columns of words share the rest, so a wide
  window leaves no dead gutter after the table. A table cell says a thing once: the Board's Stage
  is its bar alone, the station's name on its hover, beside a Now cell that says the state.
- **Separate by surface and space before lines.** A group of rows is a raised card whose fill is
  the step off the page; in dark it takes no outline (`border-edge-group` is transparent there),
  and light, whose raised step is faint, keeps a hairline. Inside it a hairline between rows is
  the only line. Don't add a rule, a card edge or a glyph where space or the surface step already
  says it.
- **Settings descriptions** (a setting's line under its name, and a group's line beside its
  title) are one short line of `text-meta` in `text-description` (`--fg-description`, the
  secondary `fg-muted`, so the name and what it does read as two levels), no wider than
  `--description-measure`; a settings segment is a full 32 px target (`SEGMENT_ROOMY`). A row's
  "Saved" and Undo show just before its control, where the change was made. Its main control (a segment, a field, a switch) leads; a row of small
  secondary toggles beside it (Sidebar sections' checkboxes) is `text-body`, muted until checked.
- **Titles and metadata:** a title at 14 to 15 px in `fg` (`text-body-strong` or `text-reading`),
  its metadata (where it is from, its state, a time, a chip's word) at 13 px in `fg-muted`
  (`text-meta`), never smaller. `text-caption` is only for what is never read for meaning: a key
  cap, a count badge, a footer's key legend. A third, quieter level (a hint, a step's evidence, a
  pending line) is `text-subtle` (`fg-subtle`), which holds the text floor like `fg-muted`; never
  fade muted text with opacity (`text-muted-foreground/70`), which the drift check flags. A
  disabled control's words are the one level under the floor, `text-disabled` (`fg-disabled`):
  subtle text on a button read as a live quiet one. Words in the accent's hue (a link, a current
  step's name) are `text-link` (`accent-text`); `text-primary` is a mark's colour, for glyphs. A title wraps
  to two lines before it is cut short at its end, and its hover says the whole of it; a sidebar
  row's title keeps to one line, so its rows stay even. Metadata a heading or the whole list already says is left out: no repo on each
  row when every row has the same one, no workspace under its own heading.
- **Key hints** inside a button are a key cap in the button's own text colour (`KEY_CAP`,
  `ShortcutKbd cap`), never a faded one; elsewhere a hint goes in the tooltip.
- **The reading column** (`thread-column`) is as wide as Settings → Appearance → Reading says and
  leans toward the sidebar in a wide pane (`--thread-lean`, 0.5 centres it). Its prose (a
  paragraph, a list, a quote) stops at `--reading-measure` (70 ch of its own size, about 85
  characters) and leads at 22/14, while code, tables and cards take the column's full width. Memory's rendered
  files and its draft review (Memory updates) use it too, the review widening to `--settings-column-wide`
  while a diff is open; Settings' pages take `settings-column` (60 rem, leaning `--settings-lean`).
  The sidebar keeps the width the user gives it, and its edge shows a grip while the pointer is
  over the column.
- **Icons: Lucide** at one optical stroke, never as decoration and never emoji. `--icon-stroke`
  (2) is the stroke at 16 px; each size token takes the stroke that draws the same line
  (about 1.33 px, as heavy as Inter's stems beside it) at its size (globals.css), so a 14 px chip
  glyph is no thinner than an 18 px toolbar one. A glyph stands in for a word, never beside the
  word it repeats: a button that says "Edit" or "Restore defaults", a status line's counts and
  a picker that shows its words take no glyph, and a picker's glyph draws only once its words
  give way. A mark that says something its words don't (a row's state dot) stays. Don't set `strokeWidth` on a Lucide icon. One size per context, from the tokens: `size-icon-bar` 18 px in a toolbar (the title bar, the
  sidebar's header and the composer's toolbar), `size-icon-row` 16 px beside UI text (rows, cards,
  menus, docks, buttons, the panel's tabs, which keep their names and fold into More by width
  rather than turn into bare glyphs, the rarer ones always under More so Focus review keeps the same tabs, and its action, whose words give way to its glyph), and `size-icon-chip` 14 px beside meta text (a chip,
  a badge, a status line). An empty state's or a panel message's lead glyph is `size-icon-empty`
  24 px, at the same stroke, in the muted colour. A disclosure chevron is 14 px (`size-icon-chip`) wherever it sits:
  the composer's choices chip, which opens a popover, draws none. A glyph beside a line of
  text is centred on that line (`h-lh` on its box, or `mt-*` to its first line when the text
  wraps), never on the block.
  - An icon button is at least 28 px square (`icon-sm` for a toolbar, `icon-xs` in a row), with a
    background on hover and focus. Its tooltip names it and its shortcut at once, and its
    accessible name says the same; a `title` on an icon `Button` becomes that tooltip. Its hover
    and open fill is `bg-accent` (`surface-hover`), the row hover's, so the target shows in dark.
  - Chrome glyphs are `fg-muted` until hovered, focused or open, in the title bar's slot too (a
    thread's role glyph, Open beside); colour on a glyph is a status it means or whose it is (a
    provider's mark, the orchestrator's glyph), never decoration.
  - The open tab, view or toggle shows a background or an underline, never colour alone.
  - One meaning per glyph, and one glyph per meaning: the Inbox (everything that needs you) is
    `Inbox`, a needs-you mark or count `Hand`, review `Eye`, take over `HandGrab`, a setup problem
    `Wrench` (the banner's lead and its folded title-bar button, never a warning sign with a count
    beside the needs-you pill's), a question `MessageCircleQuestion`, an approval
    `ShieldQuestion`, a plan `ListChecks`, effort the gauge, usage and limits
    `ChartNoAxesCombined`, Board `Columns3`, the orchestrator `Network`, a worker `Workflow`,
    Memory updates `MoonStar`, Focus `Moon`, Terminal `SquareTerminal`, History `History`, a wait
    `Hourglass`, another machine `Server` and one nothing reaches `ServerOff`. A row a chevron already folds needs no second glyph (an orchestrator's update is
    its chevron and time, and no rule: the transcript's 12 px block step sets it apart).
  - A control that acts on a choice names it: a sound's preview is one "Preview Chime" button
    beside the choice, never a row of bare play glyphs.
  - A button with words takes no glyph that says the same: no `Plus` beside "Add …" or "New …", no
    arrow or `ExternalLink` beside "Open …", no `Copy` beside "Copy …", no `RotateCw` beside
    "Retry", no `Play` beside "Run now" or "Continue", no `Undo2` beside "Undo". A menu item's
    leading glyph stays: it lines a list of items up and is scanned before the words.
  - A chart's legend is one compact line of short keys ("Break: no reading"), each key's hover
    and screen-reader text saying it in full, never a block of sentences above the charts.
- **Buttons have three styles** (`Button`, or `buttonVariants` on a link or a menu's trigger),
  never a hand-rolled bordered button:
  - **Filled primary** (`default`): the one action the view exists for, at most one per view
    ("Draft memory update" in Memory updates, "Allow once" on an approval). A destructive confirm takes the
    danger tone (`destructive`) in that place.
  - **Outline secondary** (`outline`): every other worded action that stands on its own: "Take
    over", "View changes", "Review", "Watch it run", "Always allow…". A list row's one lead action
    is outline, never filled, so a list of runs adds no primaries.
  - **Ghost tertiary** (`ghost`, or `link` for words inside a sentence): what steps back beside
    those ("Undo", "Cancel", "Discard"), icon buttons, and a toolbar's menus ("View").
  - `secondary` (the raised fill) is not an action style: it is only a toggle's on state and a
    control floating over content ("Jump to latest", a tile's corner icons).
- **A toolbar keeps two or three controls in sight;** the rest go behind one menu. The review's
  diff shows the file tree's toggle, one "View" menu (Unified or Split, Wrap lines, Hide
  whitespace changes, each checked in it) and Refresh.
- **A list row's trailing slot is its status, never an action:** History says what happened
  ("Merged", "Stopped", "Imported"), and what Enter does ("Open ⏎", "Resume ⏎") shows only on the
  cursor row, ahead of the status so the status column stays aligned.
- **One selection and focus style.**
  - The row the pointer or the arrow keys are on, in every menu, list, the palette and History,
    takes `row-cursor`: a fill and an accent bar at its start.
  - A chosen value (a card, a segment, a setting, a repository) takes `choice-selected`, an
    accent-tinted fill and edge, with a check where it has room; never colour alone. A menu's
    current value is its check.
  - Keyboard focus is the `focus-ring` outline (`--focus-ring`, `--focus-width`); a menu, list or
    dialog never rings as a whole.
- **The composer's toolbar is icons with their words on hover** (Johan's ruling, 2026-11-08: "we
  have moved too far in the text direction"). Every control on the row is a glyph whose words are
  its tooltip and its accessible name, and nothing measures or folds it. Two exceptions: the
  model's name on the choices chip (Johan, 2026-11-11: "I want to actually see the model name"),
  and a warning, not a control: the worker's "Sending takes over from the orchestrator" line
  (below).
  - Every composer (the orchestrator's chat, a solo thread's and `/new`) has one choices chip for
    model · effort · mode · speed: the agent's mark, the model's name as the model picker lists it
    less the vendor the mark says ("Opus 5.5"), then the mode's 14 px glyph, and Fast's filled bolt
    while on. Each mode has its own glyph, on the chip and beside its row in the popover: Ask's
    lock, Accept edits' pen on a file, Plan's checklist, Auto's checked shield, Bypass's open lock
    in the warning colour. Auto never takes the Sparkles that marks a setting following the
    recommended setup. The name is the one word on the chip: it stays at every width, truncating
    with "…" only once the row has no room left, and never drops. Effort draws nothing. In `/new`
    the agent picker before it is the agent's mark alone, its name on hover, and the chip draws the
    sliders glyph in the mark's place. The chip's name and tooltip say every value and its
    shortcut, a default saying whose it is, one line each on hover: "Claude · Claude Opus (⌘⇧M)",
    "Effort: Model default (⌘⇧E)", "Mode: Auto (⌘⇧A)", "Speed: CLI default".
  - The chip opens one popover above the whole composer, never over the draft, with a section per
    dimension in the same order: a heading with its value and shortcut, one section open at a time,
    its list checking the current value with a line on what each costs (the model's searches, with
    favourites; speed's says what Fast costs). A dimension that doesn't apply keeps its section,
    greyed, "Not available", with why on hover and once opened, so the rest never move. Each
    dimension's shortcut opens the popover on its section, a pick closes it, and the pick is
    confirmed in words for a moment ("Effort set to High").
  - Every target on the row is 32 px tall. Stop is an icon button in Send's place and at Send's
    size: a filled square inside the running ring, on a solid fill in the text colour (danger under
    the pointer), with no word and no key cap; its tooltip says "Stop (⌘.)", its name "Stop", and
    ⌘. stops from the focused composer. While the turn only waits on your answer, Stop steps back
    to the danger tint (no ring), still distinct from Send and from a faint outline. Into a worker
    the orchestrator still directs, a message takes it
    over, said once in plain words where it happens: the placeholder only names where the message
    goes ("Message this worker…"), Send's name and tooltip say "Send and take over from the
    orchestrator", and with a draft the line beside Send says "Sending takes over from the
    orchestrator". Beside Send the context meter is its bar alone in a 32 px target, never a ring;
    the pointer opens its popover, headed "Context 36%", which says what it measures.
- **The Inbox is one dialog over the work**, the same list and keys in Quiet and out of it and at
  every window size. It never takes the side panel's column: the chat and the panel stay as they
  were under it, and opening an item's thread closes it.
- **One worker list:** the right panel's Workers tab, by state, each row its dot, title, age and
  one status line without the state its heading says. ⌘J, Workers in the title bar's "…", the
  palette and the status strip's count open it with the keys on its rows; ⌘J again puts the panel
  back as it was. There is no second list in a dialog, and while the tab is open the sidebar folds
  its workspace's workers to its line ("7 in Workers"), its chevron leading
  to the tab.
- **An explanation shows once, then folds into its control.** What Take over changes is a line
  under a worker's header the first time it is offered; after, Take over's own hint says it, with
  no ⓘ beside it to say it again, so the line never stacks over every worker view.
- **Icon-only chrome names itself on hover:** the title bar's and the overview header's icons use
  the instant tooltip (`Hint`), never a native title, with the shortcut where there is one. A hint
  opens when the pointer moves onto its trigger, never for one that appears under a resting
  pointer, and opens on the side away from what sits next to it (a panel's tabs above, over the
  panel's empty top, not over the notice under them).
- **The title bar is icon-only and few:** the workspace, Chat · Board and the thread's title (an
  orchestrator's is its Memory glyph alone: the switcher and Chat already name it, so no role
  glyph), then
  what wants you (the Inbox while the sidebar is hidden, a setup problem folded from its banner as its glyph alone, a paused workspace, usage, the bell), one "…" with everything else in words and
  shortcuts, and the panels' group at the end (a worker's Open beside, then the panel's toggle). The usage meter
  is an icon button like the bar's others, usage's glyph alone, its reading in its hover and name. A dot on
  its corner is the one hint of a limit: a warning ring from 90%, filled amber once past the window on
  credits, red once spent; no words, and nothing moves. It
  follows one rule (on a thread its agent's closest limit, unless another's passes 90%; elsewhere the highest),
  and its hover and popover name which ("This thread: …", "Highest: …"). Every glyph in the bar is
  one of its icon buttons, `icon-sm` with the toolbar glyph (18 px, one stroke), `fg-muted`, the
  `bg-accent` hover fill, and its instant hint; a pane header's own glyphs keep the row size. A popover from the bar drops clear of a
  card that asks for a decision. The overview's header holds its own two toggles; Settings sits beside History at
  its foot. A new control goes in the "…" unless it is needed at a glance. A
  thread's title comes before its secondary buttons: the bar folds a worker's actions into "…"
  before it cuts the title (up to a cap). Settings is a place of its own: Back and its name in place
  of the workspace and its views, and no overview beside it.
- **A status strip keeps its words:** short of room it drops whole items from its end, never their
  words, so a count never stands alone and no two read the same.
- **One band above the transcript, one below, and only what nothing else says.** Over the
  orchestrator's chat is "Since you left" as a fold (its Dismiss inside, no ×), one quiet muted
  line with no rule under it, and nothing else: running, review and merged counts are the
  sidebar's and the Board's, and Show all activity is a view option (the title bar's "…" under
  View, a pane's "…"). With no absence to sum up the line is gone, with no empty band. "New" is
  the transcript's own line, over the first message you haven't seen. A worker's PR and CI are
  the strip above its composer, and Take over stays the title bar's (the strip adds no second one).
- **The orchestrator's reply is the strongest thing in its chat.** An update ("09:52 Update · 2
  merged · More") and an event Gram's own tools report there ("Started a worker", "Queued to merge
  when ready") are quiet meta, a line of `text-meta` in `fg-muted` at regular weight behind its
  chevron, never a card; only an ask (amber) or a failure (red) colours one, and a call still
  running, waiting on you or failed keeps its card. A merged feature is the same kind of line
  ("history-sort · Stable sort in History merged gram#141"), flat, its PR chip the one mark; a
  feature still moving keeps its card. **A run is one line:** two or more quiet rows in a row
  (updates and merged lines, with no reply or message of yours between them) fold into one,
  "09:54–09:57 Updates · 3 merged · 1 report · More" (merged lines alone, "6 merged"), which
  opens in place on each row as it stood, by click, Enter or Space. Its words sum every row it
  holds, so an ask or a failure inside it is still said there, amber or red. A single update stays
  as it is, a live card ends the run, and Show all activity shows every row unfolded. One 12 px
  step separates every block of the stream, a reply from an update the same as an update from the
  next reply: a message's Copy, its "…" and its time float on hover (beside a bubble's top, over
  the end of a reply's last line)
  instead of reserving a row under it. They float only with a pointer that hovers and a message at
  least 40 rem wide (`float-actions`); on touch, where they always show, and in a narrow column
  they keep their row.
- **Motion is short and springy:** 220 to 320 ms with the theme's ease-out, springs for presses
  and arrivals, and none under reduced motion.

## Tokens

Every size, space, radius, shadow and colour in `apps/web/src` comes from a token. The type scale
and radii are per look in [`@gram/themes`](packages/themes/src/looks.ts); spacing, elevation and
selection are in [globals.css](apps/web/src/styles/globals.css) and
[tokens.css](apps/web/src/styles/tokens.css).

**Type scale.** Seven steps, each with its line height; three carry a default weight that a
`font-*` class can still override.

| Class              | Size / line | Weight   | For                                                               |
| ------------------ | ----------- | -------- | ----------------------------------------------------------------- |
| `text-caption`     | 11 / 16 px  | inherits | Key caps, count badges, a key legend. Never meaning or a heading. |
| `text-meta`        | 13 / 20 px  | inherits | Metadata, timestamps, chips, help, a row's trailing words.        |
| `text-body`        | 14 / 20 px  | inherits | UI text: rows, menus, buttons, labels, settings.                  |
| `text-body-strong` | 14 / 20 px  | 500      | A row's or card's title; an emphasised label.                     |
| `text-reading`     | 15 / 24 px  | inherits | Content: messages, descriptions, inputs, a dialog's body.         |
| `text-title`       | 17 / 24 px  | 600      | Dialog, pane and section titles.                                  |
| `text-heading`     | 24 / 32 px  | 600      | A page's heading (a Settings page, an empty state, Welcome).      |

Every step but body-strong is a size of its own, every line height is on the 4 px grid, and meta
sits two pixels above caption, so incidental text never passes for metadata. Headings separate
from body by size, weight and tracking together: title draws at −0.012 em and heading at −0.02 em
(Inter is drawn for text sizes, so its display sizes tighten), caption opens to +0.01 em, and the
rest keep Inter's own spacing (`--type-<step>-tracking`). `fg-muted` is 45% of the way from the
text to the palette's muted seed in dark and 60% in light, where dark text on a pale page needs
the larger step to look as far apart: well over AA in every palette, and a clear second level
under a title.

Markdown in the transcript keeps its own scale, sized by Settings → Appearance → Reading.

**Spacing.** Tailwind's numeric steps are 4 px (`p-1` is 4 px, `p-4` 16 px); stay on whole steps,
with half steps (`0.5`, `1.5`) only to centre something optically inside a control. Named steps
say what the space is for: `tight` 4 px (an icon and its label), `inset` 8 px (inside a row or
card, between cards), `list` 12 px (around a list's rows and headings), `section` 16 px (between
sections, at a pane's edges), as in `gap-inset` or `px-section`.

**Radius.** `rounded-2xs` 4 px, `rounded-xs` 8, `rounded-sm` 12, `rounded-md` 14, `rounded-lg`
and `rounded-xl` 16, `rounded-full` for pills and dots, and `--composer-radius` for the composer.

**Elevation.** Three surfaces: the chrome (`surface-1`), the page (`surface-2`) and one raised step
(`surface-3`). In dark the raised step is a clear one on near-black palettes (5.5% lightness over
the lighter of the other two, 3.5% on mid-tone ones that already separate), so a card reads by its
fill; Neutral Dark is near-black (`#131313` page, `#0b0b0b`
chrome), not black. Hover sits a shade past the raised step. One step for every secondary
surface: a card, a panel's block, a popover and a menu
take `bg-card` or `bg-popover` (both `--surface-raised`, which is `surface-3`: the palettes hold
muted text at AA there) and the edge `border-edge`, which carries the step in dark where a shadow
doesn't show; a row that opens or acts (a tool row, an update, the files-changed row) takes the
firmer `border-edge-action`. A plain divider stays `border-border`. `shadow-raised` for a card on a surface, `shadow-overlay` for what
floats (a menu, a popover, a toast), `shadow-modal` for a modal dialog over the scrim (History, a
confirm), `shadow-composer` for the composer slab. The scrim (`scrim`) dims toward the chrome surface,
82% in light and 78% in dark, and blurs the page a little (`--scrim-blur`), so the transcript
behind History or the palette reads as a backdrop and never competes with the list in
front. More contrast and forced colours turn the shadows and the blur off and the edges to
`border-strong`.

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
- Headings are sentence case too, never all caps: a sidebar section ("Solo threads"), a settings
  group ("Mode"), a PR panel section ("Checks"), a palette group and a chapter divider.
- One word set per action, on every surface. An approval is "Allow once", "Always allow this
  rule…" and "Deny" in the thread, the Inbox, the Board and a notification (the verbs live in
  `thread/request-model.ts`), and its receipt names the scope chosen: "Allowed once", "Always
  allowed …", "Denied". A failed step offers "Retry". A search that finds nothing says "No matches".
- An ellipsis (…, never three dots) ends a button or item only when it asks for more before acting
  ("Always allow this rule…", "More…"), and a placeholder ("Message…").
- A short empty state is a fragment without a full stop ("No files yet", "Nothing needs you"); one
  that goes on to say what to do is sentences, with full stops.
- An empty view is `EmptyState` (`components/empty-state.tsx`) on every surface: its glyph, that
  fragment as its title, one sentence on what goes there, and at most one action, an outline
  button ("Message the orchestrator"). Home with nothing set up is the exception: its "Open a
  repository" is the app's one way in, so it is the filled primary, and the sidebar leaves the
  message to it. Never a row of empty groups where one line would say it.
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
