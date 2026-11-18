# Pick an element in Preview

## Problem

To point the agent at something on the page in Preview ("this button is misaligned"), you
describe it in words or paste a screenshot. The agent then guesses which element you mean.

## Who and where

Someone with a thread's Preview open on their dev server, desktop app, light and dark.

## Must show

- Rest: Preview's toolbar with one new button, Pick an element, beside Inspect.
- Picking: the page under a hover outline with the element's selector and size; a strip saying
  "Click an element to add it to your message · Esc to cancel"; the button pressed.
- Picked: a chip in the composer, the same chip diff comments use, naming the element
  ("button.pay · Pay now"); its hover says what the agent gets: the page address, the selector,
  the element's HTML (cut), a few computed styles and a crop of it. The note is what you type.

## Out of scope

- Notes pinned on the page (the other agent app keeps page notes in the browser): the composer
  already holds the message, so the note goes there, as with diff comments.
- Picking in the server's browser (Gram on a server); the desktop Preview only for now.

## Open questions

- Icon: the kit has no pointer-in-a-square icon; the build would use lucide's
  `SquareMousePointer`. The mock shows the kit's hand.
- Does the agent also get a crop image? Default: yes, as an attachment, like a pasted screenshot.
