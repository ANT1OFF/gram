---
name: feature-map-upkeep
description: Drive every feature in docs/features.json in the mock UI and fix the entries whose words no longer match what a person sees. Use for the scheduled feature-map pass, or when asked to check, refresh or audit the feature map.
---

# Feature-map upkeep

`tools/feature-map/check.mjs` catches a path, heading or test id that no longer exists, and
`bun run drive --all` catches a feature that is no longer where its steps say. Neither catches an
entry whose words went stale: a page moved under another settings group, a tab that now sits in
a menu, a purpose that lists pages that are gone. This pass reads each feature as a person sees it
and fixes the words. It follows pstack's feature-map upkeep (Cursor's pstack plugin, MIT), with
no code from it.

## 1. Drive every feature

```sh
bun run drive --all --no-shot --full
```

On the cloud machines add `--chromium /opt/pw-browsers/chromium`. Each feature gets
`<slug>.aria.yml`, the whole page's accessibility tree with `--full`, so the settings navigation
and the sidebar are in it. A feature that is not reached is a finding by itself: fix its `ui`
steps or landmark first (docs/VERIFICATION.md#reaching-a-feature-by-name).

## 2. Compare each entry with what it shows

Read the `.aria.yml` files, not pictures. For each feature with a `ui` block, check:

- **`where`** names the sidebar region, settings section, tab or menu the tree shows, in its
  exact words. The settings sections are the links under `navigation "Settings sections"`; a page
  under one of them is "Settings → <section> → <page>". A tab behind "More tabs" says so.
- **`purpose`** still says what the screen does, and any pages or controls it lists still exist
  under those names.
- **`name`** is the word the app uses. Rename only when the app's word changed, and grep `docs/`
  for the old name in the same change.

For features with no `ui` block, check `purpose` against the code and the docs headings the entry
names.

Change the entry, never the product: a screen that reads wrong is a separate issue to raise.

## 3. Land it

`bun run lint` (the feature-map check) and `bun run fmt`. Open one pull request titled
`docs: the feature map matches the app again`, listing each change with the words in the tree
that showed it was stale. A pass that finds nothing stale opens no pull request and says so.
