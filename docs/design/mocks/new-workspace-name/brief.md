# New workspace: a name, and a wider sheet

**Problem.** A new workspace is always named after its home repository, with no way to name it
when making it ("the name comes from the home repository; renaming waits for its settings"). And
the sheet is one narrow column (`max-w-lg`, 512 px) of eight stacked parts: on a 1440 × 900 window
it runs to about 960 px tall and scrolls, with most of the window empty beside it.

**Who and where.** Anyone starting a workspace and its orchestrator: New workspace from the
sidebar, the palette, the first-run card, or New task's "new workspace" target. An embedding app
shows the same sheet under its own word for a workspace.

**Must show.**

- An optional Name field. Left empty, the workspace takes the first repository's name, numbered
  past one that exists (`api`, `api 2`), as today; the placeholder shows that name live, so the
  default is visible before Start. Before any repository is picked it says so.
- Every part the sheet has today: repositories (chips, Add with the list and the path field),
  autonomy (three levels), repository access where the embedding app gives it, models (folded),
  "What should it work on?", "Read the repositories first", "Start will" steps, Start, Save
  without starting, Cancel, "Setup from …".
- States: one repository picked with no name typed; a name typed; Add open.
- Fits a 1280 × 800 window without scrolling with Add closed; stacks to one column on a phone.

**Out of scope.** What the parts do, their wording, Start's behaviour, renaming an existing
workspace (settings already does), and the other requests made alongside this one.

**Open questions (defaults picked).**

- The field's label is "Name", placed first: a name is what you'd expect to set first. Default:
  first.
- A typed name is kept as typed, never numbered. One another workspace has is refused under the
  field before the save, as the server refuses duplicate names.
- Layout: two directions, A Two columns and B Wide rows.
