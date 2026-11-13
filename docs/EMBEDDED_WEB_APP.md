# Mounting Gram in another app

[Up: documentation map](README.md) · the server side is [running Gram behind another service](EMBEDDING.md)

Gram's web app can be mounted whole inside a web app of your own: a service that runs Gram behind
it and has pages of its own to show beside Gram's. Your app supplies the page and a little of the
shell; every screen of Gram's is Gram's own code, talking to a Gram server.

It is one of the [hosted features](DOCKER.md#hosted-features). Mounted against a server that has
that setting off, the app is exactly what it is on its own and everything you tried to add is left
out. Nothing here changes the desktop app.

## The package

`bun run --filter @gram/web build:embed` writes `apps/web/dist-embed`:

| File                      | What it is                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `gram-web.js`             | The entry, an ES module. It loads the rest as it needs it.                          |
| `gram-web.css`            | Every style of the app, fonts included. Link it once.                               |
| `gram-web.d.ts`, `types/` | The types below, as [contract.ts](../apps/web/src/embed/contract.ts) declares them. |
| `gram-web-kit.js`         | Gram's own controls, for your pages (below).                                        |
| `theme.css`               | The names of Gram's theme for your own Tailwind build (below).                      |
| `chunks/`, `assets/`      | What the entry loads later, found relative to it.                                   |
| `package.json`            | The manifest: the two exports, and React as an exact peer.                          |

React is not in the package. Your app brings `react` and `react-dom` at the versions the manifest
names, so that your components render in the same tree as Gram's. Bundle the package as a
dependency like any other; if your bundler pre-bundles dependencies in development (Vite does),
leave this one out of that step (`optimizeDeps.exclude`), so its chunks and assets keep their
places.

## Mounting

```tsx
import { mountGram } from "@gram/web";
import "@gram/web/style.css";

const gram = await mountGram({
  element: document.getElementById("root")!,
  server: { base: "/cells/acme/" },
  basePath: "/w/acme",
  shell: {
    routes: [{ path: "/govern/policies", component: Policies }],
    navigation: [
      {
        id: "govern",
        label: "Govern",
        items: [{ id: "policies", label: "Policies", to: "/govern/policies", icon: ShieldIcon }],
      },
    ],
    workspaceSwitcher: Switcher,
  },
});
```

The app takes the whole window, and a page mounts it once: its stores, its keyboard handling and
the theme attributes on `<html>` belong to the page. To show another server, load the page again
with other options.

| Option     | What it is                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `element`  | The element the app fills.                                                                                                                                                                                      |
| `server`   | Where the Gram server answers: `base` is a path on your origin, or a whole URL, and the socket (`ws`) and every HTTP call go under it. Left out, it is the page's own origin. `"mock"` is the in-memory server. |
| `basePath` | The path Gram's own routes sit under, when your page isn't at the origin's root. A thread is then at `<basePath>/t/<id>`.                                                                                       |
| `shell`    | What you add: below.                                                                                                                                                                                            |

The server authenticates the browser the way it does for Gram's own page, so serve it from your
page's origin, behind whatever puts the signed-in person's identity on each request
([sign-in through a proxy](DOCKER.md#sign-in-through-a-proxy)). Calls carry the origin's cookies and no
others.

`server: "mock"` mounts the app against the in-memory server Gram's own development uses, with the
hosted features on and sample threads in it. It needs no server at all, which makes it the way to
build and test the pages around Gram.

The answer is a handle: `shell` says `"on"` or `"off"` (whether the server took your additions),
`update` replaces what it names of the navigation, the switcher and `threads` and keeps the rest
(`update({ navigation })` changes counts and keeps the switcher; a key given as `undefined` takes
that part away), `navigate` moves the window to a path under the app, and `unmount` takes the app
off the page.

## What you can add

**Pages.** Each of `routes` is a path and a React component. The page is drawn in the
conversation's place, with Gram's sidebar and title bar around it, and scrolls on its own. A path
is written the way Gram's router writes them (`/agents/$agentId`), and the component is given the
parameters as `params`. Give a page a `title`: while it is open the title bar says it where Gram's
own pages name the workspace and its views, and a phone's header says it over the heading of the
group that lists the page. A path that Gram has itself (`/`, `/t`, `/w`, `/new`, `/new-task`,
`/new-workspace`, `/settings`, `/threads`, `/usage`) is refused when the app mounts, as is one added twice.
Routes are read once, at mount.

**Navigation groups.** Each group is an optional heading and its destinations. A group's
`placement` is `main`, at the top of the sidebar's list under Needs you and search and above the
workspaces and threads, or `foot` (the default), at the foot of the sidebar above History. They
are listed the same way in the phone's drawer, as icons in the compact sidebar (a destination
without an `icon` shows its first letter; `main` groups above the workspaces' tiles), and in the
command palette under the group's name. A destination's `to` may be one of your pages or one of
Gram's, and it is marked while the window is at it or under it. A destination's `count` (above 0)
is drawn at the row's end, and as a dot on its compact tile.

**Gram's threads.** `threads: "hidden"` leaves the workspaces and threads out of the sidebar, the
drawer and the compact sidebar, for an app whose own places lead. Needs you, search and the
palette still reach every thread, and a thread still opens from its address.

**The compact sidebar.** Mounted on a server with hosted features on, the compact sidebar is a
quiet strip of what the open one holds, in its order: your switcher, Needs you (a dot while
anything waits), Search, your `main` groups' icons a gap apart, then at the foot your `foot`
groups, History and Settings. It has no workspace or thread tiles. Resting the pointer on it, or
moving keyboard focus into it, slides the open sidebar over the page beside it; leaving both,
Escape, or going somewhere closes it, and its pin keeps the sidebar open. Gram on its own keeps its
rail.

**What needs someone.** `attention` (`{ count, label?, to?, onOpen? }`) puts your count in place
of Gram's own Needs you: the sidebar's pill says `label` (or "N need you"), the compact strip's tile
and the title bar's Inbox show a dot, and a click goes to `to`, or calls `onOpen`, or opens Gram's
Inbox. At 0 the pill hides. Update it through `update({ attention })`; `undefined` gives Gram's own
count back.

**A home page.** `home` (`{ title, component }`) is the page at `/`, in place of Gram's own home
and its first-run welcome ("Open a repository"), which is then never shown. Its title shows as an
added page's does. A launch at `/` stays on it.

**Open threads.** Mounted, the app neither restores the pane grid the server saved nor saves its
own: everyone who opens your app shares that server, so its grid is no one viewer's. Each tab
starts with nothing open, and a thread's address opens that thread.

**All threads.** `/threads` is Gram's page of every thread (archived ones are in History): those
that need you first, then the latest, each with its state, its place, what started it and its last
activity, with search and New task. Link it from a navigation group, especially with
`threads: "hidden"`.

An address under the app with no page shows "Nothing here" with the path and a way home, in the
shell.

**A switcher.** `workspaceSwitcher` is a component of yours, for whatever your app switches
between: organisations, or workspaces that live on other Gram servers. It is drawn at the head of
the sidebar, as a tile in the compact sidebar, and at the start of the title bar while the sidebar
is hidden; `placement` tells it which. Gram's own workspace switcher stays where it is and lists
the workspaces of the one server.

Inside your pages and switcher, `ShellLink` is a link to a path under the app that doesn't load
the page again, and `useShellLocation()` gives the path the window is on (without `basePath`) and
a `navigate`.

## Pages that look like Gram's

`@gram/web/kit` exports Gram's own controls: `Button`, `ButtonGroup`, `Badge`, `Alert`, `Switch`,
`Tabs`, `Select`, `Collapsible`, `Tooltip`, `Hint`, `Input` (with `invalid`), `InputGroup` (a
field with a `prefix` or `suffix` such as a unit), `Meter` (a share from 0 to 1, amber from 90%
and red when spent, or the `tone` you give it), `Popover` (hung from a `trigger` button, as the
title bar's are) and the class joiner `cn`. For a page of settings it has the pieces Settings is
built from: `Page` (the column with the page's title, a line on what it is for and its actions),
`SettingsGroup` (a titled card), `SettingRow` (a setting's name and description with its control
at the right, and an `error` under it), `Field` (a label over its control), `OptionGroup` (a
segmented control) and `Toggle` (a row with a switch). They are the
components the app itself draws, from the same build, so their styles are already in
`gram-web.css` and a tooltip of yours opens under the app's own provider. The list grows as
pages need more; a control added to it keeps its props.

For your own markup, `@gram/web/theme.css` gives a Tailwind 4 build of yours the names of Gram's
theme: its colours (`bg-surface-3`, `text-muted-foreground`), type steps (`text-meta`,
`text-heading`), named spaces (`p-inset`, `gap-section`), icon sizes, variants (`dark:`, `phone:`)
and utilities (`focus-ring`). The values behind the names are the custom properties the app's
stylesheet sets on `<html>`, so your pages follow the person's palette, mode and look.

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) source("./");
@import "@gram/web/theme.css";
```

Leave Tailwind's base styles out, as above: the page's are Gram's. Follow
[the design notes](../DESIGN.md) for which name goes where.

## Keeping embedders in step

An app that mounts Gram ships the commit of Gram it was built against. It gets a change to one of
Gram's screens only when it moves to a newer commit, and what it wrote around those screens (the
options it mounts with, its own pages on the kit, the tests that click through Gram's screens)
is kept by hand on its side. So what such an app can see or name is a surface to change with care:

- the mount options and the handle ([contract.ts](../apps/web/src/embed/contract.ts)), the kit's
  exports and their props, and the names in `theme.css`;
- Gram's own paths, and the `data-testid`s and labels of the screens an embedder's page links to
  or its tests drive: a thread, the page of every thread, the New form, the Board, a workspace's
  menu and settings, the sidebar and its compact strip;
- the words Gram's screens use for a kind of thread and the ways to start one.

When a change touches that surface:

- **Add where you can.** A new option is optional and off by default, and a kit control keeps its
  props. A renamed theme name keeps the old one beside it until embedders have moved.
- **Say what was removed, renamed or re-worded.** The pull request's description has a line
  headed "Embedders": what an embedding app must change when it takes this commit (an option to
  drop, a selector, a word), or "nothing". It is what the person moving an embedder forward reads.
- **One word set.** Gram's own words are the default on every screen. An embedder with other
  words gives them through the mount options; if a screen says something no option covers, add
  the option and do not special-case an app. A new kind of thread, or a new way to start one,
  gets its wording option in the same change.
- **Colour, type and space stay in the theme.** An embedder's pages take them from the theme's
  names only, so a look meant for both goes into the theme and `theme.css`, not into one screen.
- **Look at it embedded.** `e2e:embed` checks the mounted app still works; for a change of looks,
  the before and after screenshots include the screen mounted in an embedding app's shell
  (`server: "mock"` with a `shell`), where the sidebar, the title bar and the words differ.

Embedding work lands on the `integration/embedding` branch, which takes `main` by merge. A UI
change merged to `main` reaches embedders only after that merge, so merge `main` in soon after
one lands, and carry its "Embedders" line into the merge's description.

## Limits today

- Layout, drafts and theme are kept in the browser's storage for the origin, not per server. Two
  servers shown from one origin share them.
- The browser tab's title is Gram's.

## Checking it

`bun run --filter @gram/web e2e:embed` builds the package, builds a
[separate app](../apps/web/e2e-embed/fixture/src/main.tsx) that consumes only the build, and
drives it in a browser: the whole app mounts, an added page opens from the sidebar, the palette
and its address and is named in the title bar and on a phone, the switcher moves between the
sidebar and the title bar, pages of its own use the kit (a page of settings among them) and the
theme's names, and all of it works
under a base path. CI runs it in the first e2e shard.
