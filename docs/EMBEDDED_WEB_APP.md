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
| `classes.txt`             | Every class in `gram-web.css`, for that build to write again in one order (below).  |
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

`mockThreads` gives that server threads of your own beside its own, each at an id you choose with a
title and a plain-text conversation so far: `{ id, title, messages: [{ role, text }] }`. A page of
yours that shows one of your threads then has something to show in a preview. With
`awaitingMachine: {}` the thread is one [started before its machine](#a-thread-started-before-its-machine):
its `user` messages wait in its queue, and `awaitingMachine: { failed: "…" }` is one no machine
came for, saying that sentence. It is ignored with a real server.

The answer is a handle: `shell` says `"on"` or `"off"` (whether the server took your additions),
`update` replaces what it names of the navigation, the switcher, `threads`, `panel`, `threadsPage`, `newEntry` and `document` and keeps the rest
(`update({ navigation })` changes counts and keeps the switcher; a key given as `undefined` takes
that part away), `navigate` moves the window to a path under the app, and `unmount` takes the app
off the page.

## Recovering a fronted session

When your app owns sign-in, set `server.session` to `{ refresh, expired }`. After a socket drops
and the HTTP probe answers 401, Gram calls `refresh()` once per retry wave, with no concurrent
refreshes. Renew the app's cookie from its signed-in session and return `true`: Gram retries the
connection and the server checks its credentials again. Return `false` only when the session has
ended; Gram stops retrying and calls `expired()`, where your app unmounts Gram and shows its own
sign-in. Throw for a temporary sign-in service outage: the connection keeps its normal backoff.
A reply after feeds reconnect is ignored. Keep your identity SDK active for the page's lifetime;
this hook also covers tabs that wake with an old cookie. No token is supplied to Gram's UI.

Without this option, desktop Gram still shows its launch-token expiry screen. A fronted server
does not accept that token at all: each HTTP request and socket upgrade needs the proxy's signed
identity. Its short lifetime is independent of the cell process and of the portal session.

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
Gram's, and it is marked while the window is at it or under it. A destination may list other paths it is
also marked at in `alsoAt` (a row to `/threads` naming `/t` and `/new` stays marked inside a thread
and on New task); a row whose own `to` matches comes first. A destination's `count` (above 0)
is drawn at the row's end, and as a dot on its compact tile. A group with a `label` may be `collapsible`: its heading
then opens and closes its rows in the open sidebar and the phone's drawer, and `collapsed` starts
it closed. Once the person opens or closes it, their choice is kept on the device by the group's
`id`. Closed, it still shows the row the window is at, and its heading says the sum of its hidden
rows' counts; the compact sidebar and the palette list its rows either way.

**The compact sidebar's peek.** Resting the pointer on the compact strip opens the sidebar over the
page beside it. `sidebar.peek: false` turns that off: the strip then has an Expand sidebar tile at
its head, which opens the sidebar again, and focus from the keyboard still opens it over the page.

**Gram's threads.** `threads: "hidden"` leaves the workspaces and threads out of the sidebar, the
drawer and the compact sidebar, for an app whose own places lead. Needs you, search and the
palette still reach every thread, and a thread still opens from its address.

**The right panel.** `panel: "code"` offers the right panel (Diff, PR, Files, Terminal and its
other tabs) and its title-bar toggle only on a thread that works in a git repository, a worktree or
a checkout. On every other page (a thread outside a repository, `/threads`, the home page, the
embedding app's own pages) neither shows, its key does nothing and its palette commands are left
out. `shown`, the default, offers it everywhere, as Gram on its own does. Change it through
`update({ panel })`.

**Starting work, in your words.** `threadsPage: { title: "Chat", newLabel: "New chat" }` renames
the page of every thread (`/threads`) in its heading, the title bar, a phone's header and the
palette, and words its button, which then starts a chat. `threadsPage.kinds` gives your words for
what kind of thread a row is (`{ solo: "One agent", orchestrator: "Team lead", worker: "Team
member" }`), for people who do not speak of orchestrators and workers. Your word for `solo` also
names that choice in the New form, in place of "Chat", and a solo thread's header, so an app with a
Chat of its own has one word for a thread run by one agent. `threadsPage.newForm` narrows and words
the New form's Who does it: `task: "hidden"` leaves out the choice of one worker straight away, and
`team` and `solo` each take a `label`, a `line` under it and the button's `start` words.
`threadsPage.elsewhere` is a list of thread ids the page leaves out: threads your app lists in a
place of its own, such as its own assistant's conversations. Each still opens at its address.
`threadsPage.places` names places of your own that some threads open in
(`{ name: "Chat", path: "/chat/$threadId", ids }`): a message one of those threads sent to another
says the place beside its sender and opens the sender there, and a phone's header puts such a
thread under the place's name in place of a kind of thread.
`threadsPage.bar: "path"` starts the title bar of a thread, a Board, a workspace's Memory and the
New form as a path from the page of every thread, with a workspace's orchestrator, Board and Memory
as one segmented control beside it, in place of the workspace switcher and Chat · Board. Memory
then drops its own title row, which the bar already says.
`threadsPage.workspaces: { noun: "Project", plural: "Projects" }` has the page open on a list of the
workspaces in your word for one, for people who start from a workspace: each row says its
repositories, what waits on you, what runs, its open pull requests and its autonomy, and has a task
for it, its Board, its settings and its pause. A switch in the page's head counts both lists and
leads to the threads, a second button starts a workspace, and the threads in none are counted
under the list. Left out, the page lists the threads alone. `newEntry: { label: "New agent", to:
"/agents" }` makes New, in the sidebar's head and a phone menu's foot, one plain button to a page of
yours in place of Gram's menu of Task, Team and Chat: for an app where what a person mostly starts
is something of its own. Gram's New form stays reachable from the threads page, the palette and its
shortcuts. Change either through `update`.

**The tab, in your name.** `document: { title: ({ name, needsYou }) => string }` writes the
browser tab's whole title, in place of Gram's "(2) Gram". `name` is the page's name as the title bar
says it (an added page's, the home's, the threads page's; undefined on Gram's other pages, a
thread's among them) and `needsYou` is Gram's count of its threads that need the person. It is
called again whenever either changes; one that throws leaves Gram's own title. Change it through
`update({ document })`, say once your organisation's name is known. The favicon is your page's to
bring, in its own `index.html`.

**Your own tools, as your own things.** `toolCards: [{ tool: "mcp__*__create_order", component:
OrderCard }]` draws a card of yours under a tool call's row once the call has answered: for a tool
whose answer is one of your things, shown with its own links and buttons. `tool` is a name or a
pattern where `*` is any run of characters, and the first card that matches is used. The card is
given the tool's `name`, its `input` and its `output` (JSON a tool sent as text arrives parsed),
and returns null when it has nothing to show. Gram's row stays above it. Read once, at mount.

**The repositories to clone.** `repositories: { list }` lists what "Add repository" (in a new
workspace and a workspace's settings) offers as the person types, in place of the server's own
`gh` listing, which a server with no GitHub login of its own can't give. `list({ query, cursor,
signal })` answers a page: `repositories` (`fullName` as `owner/name`, and `private`), `next` for
the page after, `account` (the person's own, listed first, then each organisation by name) and
an optional `notice` with a link, shown under the list, say for where to grant access to more. It
is asked again, from the first page, a moment after typing rests, and for the next page as the
list is scrolled or walked to its end. A rejection's message is shown in the list. Any other
`owner/repo` or URL can still be typed and cloned. Read once, at mount.

**The compact sidebar.** Mounted on a server with hosted features on, the compact sidebar is a
quiet strip of what the open one holds, in its order: your switcher, Needs you (a dot while
anything waits), Search, your `main` groups' icons a gap apart, then at the foot your `foot`
groups, History and Settings. It has no workspace or thread tiles. Resting the pointer on it, or
moving keyboard focus into it, slides the open sidebar over the page beside it; leaving both,
Escape, or going somewhere closes it, and its pin keeps the sidebar open. Gram on its own keeps its
rail.

**The sidebar's look.** `sidebar` (`{ look?, header?, account?, accountName? }`) sets how the open sidebar is
drawn. `look: "standard"` (the default) is Gram's own. `look: "roomy"` keeps Gram's surface, edge to
edge, with group headings in small capitals and air above them, rows
40 px tall with 18 px icons and labels in the body's stronger weight, the current row as a solid
tile behind its icon (which glides from row to row) and a bold label, and search's shortcut as key
caps. Its head is your `header` with Gram's New beside it, and its foot holds History, Settings,
your `account` and Collapse as labelled rows, in place of the head's Hide and Compact. `header`
and `account` are components of yours (a brand mark and name; an avatar, a name and one line),
given `placement: "sidebar"`; in the standard look the header is a row under the head's toggles
and the account sits above History. The compact strip keeps its own shape in either look; the
strip's overlay takes the look without Collapse. Change it through `update({ sidebar })`.

**On a phone.** In the standard look the phone's drawer is Gram's own. In the roomy look it is a
plain menu: your `header` large at its head beside a round Search, your switcher under it, your
`main` groups as large rows (52 px, 22 px icons, plain group headings, the first group's left out),
and at its foot a button with your `account` as a round avatar, `accountName` (a short name of
yours for the person) over the word Settings, and one New pill. The button opens a sheet from the
bottom: your `account` as a full row, your `foot` groups, History, Settings and the theme. Both
your `header` and `account` are given `placement: "drawer"` there (a name alone, large; the
avatar's letter or picture alone, which Gram puts at the head of that 52 px
button), and your switcher is given `placement: "drawer"` too (one quiet line). The phone's header
is then a round menu button, the page's name centred (a thread's or the Board's state under it)
and a round "…", on the page's own ground; the menu button carries a dot while any destination
counts above 0, or `attention` does, and the Inbox button is left out while `attention` is set.

**What needs someone.** `attention` (`{ count, label?, to?, onOpen? }`) puts your count in place
of Gram's own Needs you: the sidebar's pill says `label` (or "N need you"), the compact strip's tile
and the title bar's Inbox show a dot, and a click goes to `to`, or calls `onOpen`, or opens Gram's
Inbox. At 0 the pill hides. Update it through `update({ attention })`; `undefined` gives Gram's own
count back.

**A home page.** `home` (`{ title, component }`) is the page at `/`, in place of Gram's own home
and its first-run welcome ("Open a repository"), which is then never shown. Its title shows as an
added page's does. A launch at `/` stays on it.

**Open threads.** The pane grid is each person's own: the server keeps it under the person your
proxy signed in, so a reload brings back the panes that person had open, and nobody else's. A
thread's address opens that thread in it. With a `home`, a launch at `/` restores the panes and
stays on your home; without one it opens the pane that had the focus, as Gram does on its own.

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

`ShellThread` puts one thread inside a page of yours: `<ShellThread threadId={id} />` draws its
transcript, cards and composer without the thread's own header, and fills the element you put it
in, so give that element a height. It is the same thread as on its own page (`/t/<id>`). Use it
for a conversation beside what your page shows, such as a panel at the side. `placeholder` sets the
words in its empty prompt box ("Steer this thread…" when left out), for a page that shows two
threads and has to say which one a message goes to.

`ShellThreadPanel` puts the same thread's working panels inside a page of yours: `<ShellThreadPanel
threadId={id} />` draws its Diff, Pull request, Files and Terminal under a row of tabs, and fills
the element you put it in. They are the right panel's own, so a comment on a line, a file opened or
a command typed there is the thread's. Pass `tab` and `onTabChange` to pick the tab yourself, for a
button of yours that opens it on the pull request; without `tab` it starts on the diff and keeps
its own. Use it for a sheet or a pane that shows what a thread changed, beside the conversation.

### A person's own machine

Where the server's deployment starts machines on demand ([Hosts on demand](EMBEDDING.md#hosts-on-demand)),
a person with none of their own running sees a start card under the New task and New chat composers,
in place of the error that no machine has joined. Its button asks for one (`POST
/machines/on-demand/start`, a plain request your proxy signs), with the repositories the person
checks or types. While it comes up the card shows each step the deployment reports, and once the
machine is online the card goes and the draft can be sent. Where the server starts none (the path
answers 404), the card never shows, and a page mounted without hosted features never asks.

Word it with `shell.machines`, read once at mount:

```ts
mountGram({
  shell: {
    machines: {
      noun: "sandbox",
      facts: ["Stops after 30 minutes without work", "Files kept 14 days", "About $0.07 an hour"],
    },
  },
});
```

- `noun`: the word for one, lower case ("machine" when left out).
- `facts`: up to five short lines the card lists, in your deployment's own terms.
- `startAgain`: asks for another machine for a thread that got none
  ([below](#a-thread-started-before-its-machine)).

### A thread started before its machine

A thread your service starts with its machine named later
([Before its machine](THREAD_PROFILES.md#before-its-machine)) opens at once, and its own page says
how the wait stands. Nothing is mounted for it: the thread carries the state.

- **While the machine starts.** The header's chip says "machine starting". The first message that
  waits is drawn in the conversation as the person's own, with a dashed edge and "sent when the
  machine has started" under it, then "Starting this thread's machine · usually under a minute"
  with the time since the wait began. The prompt box still takes messages, which wait in the queue
  over it ("Queued · waits for the machine"); none can be sent early. In the sidebar the thread sits
  with the working ones, and its hover says what waits and since when.
- **When no machine came.** The chip says "no machine", the message says "not sent yet, and kept",
  and the line gives way to the failure: your sentence (`failed` on `POST /threads/machine-wait`) or
  Gram's "No machine started for this thread.", then "What you sent is kept, and goes once a
  machine has started." The thread moves under Needs you, as "No machine started".
- **Try again.** Gram starts no machine, and a person's page may not call
  `POST /threads/machine-wait` (it is your service's call, refused to a signed-in person). So the
  failure's Try again is yours to answer:

  ```ts
  mountGram({
    shell: {
      machines: {
        startAgain: async ({ threadId }) => {
          const res = await fetch(`/api/threads/${threadId}/machine`, { method: "POST" });
          // `fetch` resolves on an error status too: reject, or the page reads it as asked.
          if (!res.ok) throw new Error("The machine could not be asked for.");
        },
      },
    },
  });
  ```

  Behind it your service does three things: `POST /threads/machine-wait` with `{ threadId }` alone,
  which clears the failure and begins the five minutes again; starts another machine; and names it
  with `POST /threads/move-to-machine` once it is online. Resolve as soon as you have asked. The
  page then reads "Starting a machine again · the first didn't start", counted from the new try;
  it reads so at once in the window that asked, and everywhere once the wait has begun again on the
  server. Reject (or throw) when you can't ask: the failure stays, with "Couldn't ask for another
  machine." and your error's message under it. Within one window it is called once per press, never
  while an earlier call for the same thread is still out, however many panes show the thread. A
  second window, or the page loaded again, knows nothing of a call still out and offers Try again
  until the wait has begun again on the server: so begin the wait before anything slow, and make
  the call safe to repeat for a thread (one machine, not two). If the wait has not begun again a
  minute after you resolved, the window that asked shows the failure and Try again once more. Read
  once, at mount.

  Without `startAgain` the failure has no button and says "What you sent is kept. To try again,
  start the thread again."

- **Once it is placed** the thread is as any other: the chip names its machine, the message is
  sent, and the queue goes after it.

These screens say "machine" whatever `machines.noun` is. Their `data-testid`s: `pane-machine` (the
chip, with `data-machine-state` `starting` or `no machine`), `machine-wait` (`data-state`
`starting`, `again` or `failed`), `machine-wait-message`, `machine-wait-held`,
`machine-wait-starting`, `machine-wait-elapsed`, `machine-wait-failed`, `machine-wait-sentence`,
`machine-wait-retry` and `machine-wait-retry-failed`.

### The model list

The prompt box lists the models each agent offers. Where your deployment allows only some of them,
or a person's own accounts leave some unusable, narrow the list with `shell.models`, and say what
to do when none is left. Replace it with `GramHandle.update({ models })` once you know more, such
as after reading the person's accounts:

```ts
handle.update({
  models: {
    // `runs` is the pinned id the row runs (`opus` runs `claude-opus-5-5`), by the model catalogue.
    offered: (model) => model.agent === "claude" && model.runs !== undefined && allowed(model.runs),
    none: {
      text: "Connect a Claude account to pick a model.",
      action: { label: "Model accounts", to: "/accounts" },
    },
  },
});
```

- `offered`: whether a listed model is offered, given `{ agent, id, runs, profile }`:
  - `id` is the id the agent lists it by.
  - `runs` is the pinned model id it runs, as the model catalogue (`resolveModel`) reads it. It is
    absent when the row says nothing of it, such as the CLI's `default`.
  - `profile` is the gateway profile it goes through, if any.

  Every model is offered when `offered` is left out, and when it throws. A new draft never lists a
  model that is not offered, and one that started on such a model (a discovered or saved default)
  moves to the offered default. A thread's own composer and a saved setting still show the model
  they have. It only narrows the list: your deployment still refuses a model it does not allow.

- `none`: the Model row's words when the agent has nothing to pick, with an optional link to one of
  your pages. The other agents' models stay pickable beside it. Where the list can't be read at
  all, it is shown beside Gram's own reason and Retry.

## Your app's look

`theme` gives the app your look in this page, with no change to Gram's own default:

```tsx
await mountGram({
  element,
  server,
  theme: {
    name: "House",
    palettes: { dark: { bg: "#0b0c0d", surface: "#0b0c0d", text: "#ecebe6", … }, light: { … } },
    colors: { dark: { accent: "#ecebe6", "on-accent": "#0b0c0d", "status-needs": "#c2a878" } },
    fonts: { ui: '"Inter Tight", sans-serif', mono: '"Martian Mono", monospace' },
    radii: { sm: 4, md: 6, lg: 8 },
    shadows: "none",
    chart: { dark: ["#6f6d66", "#c2a878", "#d27a6e"], light: ["#b5b2a8", "#8c6d3a", "#c4685b"] },
  },
});
```

- `palettes` are seeds, as Gram's own palettes have them, one set per mode. Gram derives every
  colour from them the way it does for its presets, and they stand in for its default pair: a
  person who never picked a palette sees yours, and Settings shows that card under `name`. A
  person who picks another palette gets it.
- `colors` are set over what the seeds derive, by the theme's names (`accent`, `on-accent`,
  `accent-text`, `status-needs`, …), for one mode or both. At More contrast the derived colours
  hold.
- `fonts`, `radii` and `shadows: "none"` set the look's values. The Fonts setting still wins.
- `chart` names colours for charts on your pages, `--chart-1` onwards. Gram's screens draw none.

Leave `theme` out and the app looks exactly as it does on its own.

## Pages that look like Gram's

`@gram/web/kit` exports Gram's own controls: `Button`, `ButtonGroup`, `Badge`, `Alert`, `Switch`,
`Tabs`, `Select`, `Collapsible`, `Tooltip`, `Hint`, `Input` (with `invalid`), `InputGroup` (a
field with a `prefix` or `suffix` such as a unit), `Meter` (a share from 0 to 1, amber from 90%
and red when spent, or the `tone` you give it), `Popover` (hung from a `trigger` button, as the
title bar's are), `AgentIcon` (an agent's mark in its provider's brand colour) and the class
joiner `cn`. For a page of settings it has the pieces Settings is
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
@source "../node_modules/@gram/web/classes.txt";
```

Leave Tailwind's base styles out, as above: the page's are Gram's. Follow
[the design notes](../DESIGN.md) for which name goes where.

### One utilities layer

The `@source` line points your build at the package's `classes.txt`, and it is not optional. Your
stylesheet and `gram-web.css` both write into the `utilities` layer, and yours comes later. Inside
one build Tailwind puts a plain class before its responsive and state variants, so `hidden` loses
to `md:flex`. Across two builds nothing keeps that order: a `.flex` your pages use lands after
Gram's `@max-md:hidden`, and every screen of Gram's with that pair stops folding at its width.

`classes.txt` names every class in the package's stylesheet. With the line, your build writes each
of them again, after Gram's copy and in one order, so the last word on every class is in the right
place. `theme.css` carries the variants and utilities of the Tailwind add-ons Gram's classes use
(`data-open:`, `animate-in` and the rest), so your build needs nothing installed for them. Point
at the list and not at the package's folder: the bundle also holds the class names of the
libraries it carries, which Gram's build never wrote and its screens are not drawn with.

It costs a second copy of Gram's utilities in your stylesheet, about a tenth more before
compression. A class of Gram's that should stay a default your own classes override can be left
where Gram wrote it with `@source not inline("…")`.

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
