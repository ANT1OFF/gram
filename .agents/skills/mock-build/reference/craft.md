# Mock craft

What separates a mock worth reviewing from one that gets thrown away. Read once per session
before the first version.

## Content

- Real content from the brief, the code or the user. Real names, real numbers, real error text.
- What isn't known stays a visible gap: `[YOUR PRICE]`, `[Customer quote]`, or a `.placeholder`
  box for an image. Never lorem ipsum, never invented statistics, logos, testimonials or users.
- Copy in the product's voice. Short labels, sentence case, verbs on buttons ("Create branch",
  not "Submit"). Times in the product's format (Gram: 24-hour).
- Every state the brief names gets drawn: empty, loading, error, long content, no permission. An
  empty state says what fills it and offers the one action that starts it.

## Look

- Start from the product, not from a blank page: the same sidebar, row height, radius and type
  the real screens use, so the difference under review is the new part.
- One to three typefaces at most; for a product mock, the product's own (tokens.css sets them).
- Zero to two accents. Most of the page is neutral surfaces and text; the accent marks the one
  primary action and the current place.
- Hierarchy from size, weight and space before colour. Muted text for secondary facts, subtle
  for tertiary; never three greys fighting.
- Tight, consistent spacing from the kit's `--gap` and `--pad`; align to a few edges.
- No AI tropes: gradients, glows, emoji as icons, glass, cards with a coloured left border,
  everything in a rounded card, Inter/Roboto/Arial when the product uses something else, centred
  everything, decorative blobs.

## Structure

- Real elements: `<button>` for actions, `<a>` for navigation, `<label>` around a field and its
  text, `<table>` for tables, headings in order. A `div` with a click handler is a bug.
- Contrast at least 4.5:1 for text; the tokens already meet it, custom colour won't.
- Touch targets at least 44 px on phone boards; the kit's `.phone` raises buttons and rows.
- Layout with flex or grid and `gap`; no margins between siblings, no absolute positioning except
  overlays. Every board must hold at 390 px wide: wrap, stack or scroll in its own box.
- No fake device chrome: no drawn status bar, notch, home indicator or keyboard. The phone draws
  its own.

## Rounds

- Directions first when the shape is open: two to four genuinely different structures, low
  fidelity, each with a stable name. Hi-fi only once one is picked.
- Targeted changes stay targeted. "Make the header quieter" changes the header, nothing else; a
  new version that also moved the sidebar has broken the review.
- Keep board names and option names stable across versions; the user refers to them.
- Tweaks are for the levers the user is weighing (density, which accent, show or hide a part),
  at most three. Never a tweak for copy.
- Say what you assumed. Every guess is a line in the reply or in `brief.md`, not a surprise.
