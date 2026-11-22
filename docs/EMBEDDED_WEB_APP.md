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
| `gram-web-kit-lite.js`    | The basic controls alone, for a page shown before Gram mounts (below).              |
| `gram-web-kit-lite.css`   | The light kit's stylesheet: Gram's theme, base styles and fonts, and its controls'. |
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

Serve the page with a Content-Security-Policy at least as strict as the one Gram's own server
sends (`contentSecurityPolicy()` in `packages/server/src/http/auth.ts`) for scripts, images,
frames and connections, widened only for what your page itself needs, such as its identity
provider. Gram renders text it doesn't trust (agents' messages, GitHub comments, files), and its
markdown never loads another origin itself; the policy is the second layer, and the only one for
anything your own pages render.

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

A destination for a person or an agent can show a `mark` in place of its `icon`: the kit's
`Avatar` at the row's icon size, with its initials (from `name`, or the row's `label`) or a
`glyph`, `shape` `round` (a person, the default) or `square` (an agent or anything else), and a
`status` dot (`success`, `working`, `waiting`, `needs`, `idle` or `error`, in Gram's status
colours) with its `statusLabel`, the status in words, which the type requires with a `status` so
a dot never says it by colour alone: a screen reader hears it after the row's name, and the dot's
hover says it. `dimmed` fades the mark; `className` and `style` go on its tile, for
a fill of your own. A group with a `label` may also have a `to`: its heading is then a link to that
page, marked while the window is at exactly that path, and on a `collapsible` group only its
chevron opens and closes the rows. The compact sidebar and the palette list rows only, so give the
heading's page a row too if it must be reachable there.

**Settings.** Gram's Settings pages are about the computer Gram runs on: agent CLIs, machines,
the terminal, review requests from `gh`, updates. `settings.gram` lists the ids of the pages of
Gram's to keep (`["appearance", "keyboard"]`, in Gram's order); a page that opens from another,
such as `terminal` from `appearance`, stays only with it. `settings.pages` adds pages of your own,
listed first, each at `/settings/<id>` with a `label`, an `icon`, a one-line `description` (under
its heading, and what Settings search reads with its `keywords`) and a `component`, drawn in
Settings' column under that heading. An id of Gram's, one that isn't lower-case words and dashes,
or one given twice is left out. A page that is not kept leaves Settings' list and search, and its
address opens Settings' first page. Without `usage` the title bar has no usage meter and a phone's
"…" no Usage; without `general` its Sending setting is on Keyboard. On a hosted server Keyboard
leaves out `keybindings.json`, a file on the server. Read once, at mount.

**The title bar's "…".** It holds the thread's, the workspace's and the window's controls (Workers,
Tidy up, Pause, Memory, the layout), so on your own pages, the `home` among them, it is not shown.
Where `threadsPage.workspaces` names Gram's workspace (a "Project"), the menu says that word.

**The compact sidebar's peek.** Resting the pointer on the compact strip opens the sidebar over the
page beside it. `sidebar.peek: false` turns that off: the strip then has an Expand sidebar tile at
its head, which opens the sidebar again, and focus from the keyboard still opens it over the page.

**Gram's threads.** `threads: "hidden"` leaves the workspaces and threads out of the sidebar, the
drawer and the compact sidebar, for an app whose own places lead. Needs you, search and the
palette still reach every thread, and a thread still opens from its address.

**The right panel.** `panel: "code"` offers the right panel (Diff, PR, Files, Terminal and its
other tabs) and its title-bar toggle only on a thread that works in a git repository, a worktree or
a checkout, and on an orchestrator. On an orchestrator the pane lists its workers by where they
stand, and opens one under "‹ Workers › its title" with that worker's own Changes, PR, Terminal
and Files; an orchestrator outside a repository gets its workers alone, none of its own Diff,
Files or Terminal. On every other page (another thread outside a repository, `/threads`, the home
page, the embedding app's own pages) neither shows, its key does nothing and its palette commands
are left out. `shown`, the default, offers it everywhere, as Gram on its own does. Change it
through `update({ panel })`.

**Esc in the worker pane.** With the keys in the pane and nothing typed in its composer, Esc goes
back from a worker to the list. Gram marks the event handled (`preventDefault`) and never stops
it, so an app that listens for Esc itself (to close a sheet of its own) sees it: skip an event
whose `defaultPrevented` is set. The arrow keys that step between workers act only with the keys
in the pane's head.

**Starting work, in your words.** `threadsPage: { title: "Chat", newLabel: "New chat" }` renames
the page of every thread (`/threads`) in its heading, the title bar, a phone's header and the
palette, and words its button, which then starts a chat. `threadsPage.kinds` gives your words for
what kind of thread a row is (`{ solo: "One agent", orchestrator: "Team lead", worker: "Team
member" }`), for people who do not speak of orchestrators and workers. `kinds.workers` is your
word for an orchestrator's workers together ("Workers" when left out): the right pane's list, the
way back to it from a worker, and the sidebar's "4 in Workers". Your word for `solo` also
names that choice in the New form, in place of "Chat", and a solo thread's header, so an app with a
Chat of its own has one word for a thread run by one agent. `threadsPage.newForm` words the New
form's Who does it, an orchestrator (Team) or one agent (Chat): `team` and `solo` each take a
`label`, a `line` under it and the button's `start` words.
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
yours in place of Gram's menu of Team and Chat: for an app where what a person mostly starts
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

**Where a workspace's machine starts.** `environments: { list }` offers a choice of environment
in a new workspace and a workspace's settings. `list({ signal })` answers `environments` (`id`,
`label` and an optional `detail`, a few words on what it is), the `default` one's id, and an
optional `manage` link (`label`, `to`: a path under your app) shown under the field. The pick is
saved on the workspace as `environment`; none means the default. A pick no longer listed is shown
as starting in the default. A workspace with one of its own runs on a machine of its own, which
your host provider starts in it ([EMBEDDING.md](EMBEDDING.md#a-workspaces-own-machine)); what an
environment installs and may reach is your app's. Without the option the field is not shown. Read once, at mount.

**More agents for the roles.** `roleAgents: ["grok", "antigravity"]` offers Grok Build and
Antigravity beside Claude Code and Codex where a workspace's orchestrator and workers are picked;
list either or both. The server decides: it admits each to those roles only when it runs with it
in `GRAM_ROLE_AGENTS` (`grok`, `antigravity`, or `grok,antigravity`), and refuses a pick otherwise.
Both run in a config home of Gram's own wherever they run, so no allow rule of the person's clears
their calls. Read once, at mount.

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

`sidebar.switcher: "titlebar"` keeps it out of the navigation (the sidebar, the strip, the dock and
a phone's menu) and draws it at the start of the title bar always, with `placement: "titlebar"`.
Draw it there as a short label of the current workspace that leads to a page of your own in
`settings.pages`, where the full switcher is.

Inside your pages and switcher, `ShellLink` is a link to a path under the app that doesn't load
the page again, and `useShellLocation()` gives the path the window is on (without `basePath`) and
a `navigate`. A page that sends the window on by itself (a redirect, or dropping a query it has
read) calls `navigate(to, { replace: true })`, so the browser's Back skips it instead of landing
on it and being sent on again.

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
- `repositories`: `"chosen"` (the default) has the person pick the repositories as they start one;
  `"theirs"` says a machine reaches every repository the person can, as them, so the card's button
  starts it at once and asks for none (`{"repositories": []}`).
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
    sidebar: { mode: "inset", margin: 8, radius: 12, icon: { dark: "#c2a878", light: "#8c6d3a" } },
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
- `sidebar` shapes the open sidebar. `mode: "inset"` draws it as a panel apart from the window's
  edges, `margin` pixels from them (8 by default), with its corners rounded and an outline all
  round; `flush`, the default, runs it to the edges. `radius` sets its corners in pixels (0 when
  flush, the `lg` radius when inset). `icon` colours the glyphs of its places and controls and
  `background` its surface, the compact strip's too, per mode, on your palettes or, without them,
  on Gram's. The current place's glyph keeps the accent and status marks keep their tones. The
  compact strip, the sidebar shown over the page from it and a phone's drawer stay flush. For your
  own markup, `theme.css` names the glyph colour `text-sidebar-icon`.

Leave `theme` out and the app looks exactly as it does on its own.

### Where the navigation sits

`defaults.navigation` sets where the main navigation sits and whether it hides when not in use, as
your app's default:

```ts
await mountGram({
  element,
  defaults: { navigation: { position: "dock", edge: "bottom", autoHide: true } },
});
```

- `position: "side"`, the default, is the sidebar at the window's left. `"dock"` draws the
  navigation as a rounded bar of icons with short labels, centred at the window's `edge` (`top`,
  or `bottom` by default): Needs you, Search, your navigation groups' places, Overview, History and
  Settings. Overview opens the sidebar over the page, with its workspaces and threads; ⌘B opens
  and closes it too. The page takes the sidebar's width.
- `autoHide: true` slides the navigation out of view at its edge while it is not in use, and the
  page takes its room. It comes back while the pointer rests at that edge, while the keyboard's
  focus is in it (it stays in the tab order and the accessibility tree; Focus sidebar, ⌘⌥S, moves
  there) and with ⌘B, which shows and hides it. Escape hides it and leaves the focus on the page.
  Reduced motion drops the slide.
- A person may pick their own in Settings → Appearance → Navigation, which wins over your default.
  A phone keeps its drawer either way.

Leave `defaults.navigation` out and the navigation is Gram's own sidebar, always shown.

### Gram's look, with your default picked by name

`defaults` picks the look a person sees until they choose their own in Settings → Appearance, by
name only. It carries no colours, so an app that follows Gram's palettes rather than shipping its
own can still choose where a person starts:

```tsx
await mountGram({
  element,
  server,
  defaults: {
    palette: "petrol-dark",
    accent: "petrol",
    sidebar: "inset",
    sidebarIcons: "accent",
    backdrop: "off",
    surfaces: "frosted",
  },
});
```

- `palette` is a built-in palette's id. It stands in for Gram's default pair, as a `theme`'s
  palettes do, and follows Mode through its pair. An id that isn't built in is ignored. With a
  `theme` that gives palettes, the theme's win.
- `accent` lays one of the accents over the palette (`ACCENTS` in `@gram/themes`); `palette` keeps
  the palette's own.
- `backdrop` is a background picture (`fjord`, `dunes`, `pines`, `coast`, `peaks`, `waves`) or
  `off`, and `surfaces` how opaque cards, the sidebar and the title bar are over it (`solid`,
  `frosted`, `clear`). Gram raises the wash over the picture and the surfaces' opacity as far as
  the palette's text needs to hold the contrast target over the scene.
- `sidebar: "inset"` draws the open sidebar as the panel `theme.sidebar.mode: "inset"` does, and
  `sidebarIcons: "accent"` puts its glyphs in the accent's text colour.

Each part applies only while the person hasn't chosen it; their own choice always wins. Pass the
same `defaults` to `applyGramTheme` on the pages you draw before Gram mounts, so they paint the
same palette.

### Where a person's look is kept

By default a person's look (Settings → Appearance, and the palettes they make) is saved with the
server's settings, and the server's copy wins when the app starts and each time its event stream
reconnects. On a server several people share, that look is everyone's: one person's change of mode
reaches the others at their next reconnect. An app that mounts several servers from one origin sees
each server's own look in turn. `appearance: "device"` keeps the look in the browser instead,
the same against every server the page mounts, and leaves the server's saved look unread and
unchanged:

```tsx
await mountGram({ element, server, appearance: "device" });
```

The rest of the settings (the sidebar and panel, the overview) are still the server's.

### Gram's palette as data

An app that draws its own pages in Gram's colours, and would rather not run Gram's code to learn
them, reads `packages/themes/palette.json` from the repository at the commit it pins. It holds the default palette and its pair: `defaultPaletteId`, then `light` and `dark`,
each the preset's `id` and its `colors`, every colour the theme names (`surface-1`, `fg`, `accent`,
…) derived at standard contrast, as `#rrggbb`. It is plain JSON, so a build or a CI job can fetch
it for a commit with no checkout or install. The themes package's `palette:data` script writes
it, and a test fails when it differs from what the theme's sources derive.

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

For records and trees at scale:

- `DataTable<T>`: a table with headers that sort it. `columns` (`{ id, header, cell(row),
  sortValue?, align?, width?, hideOnPhone? }`, the `DataTableColumn<T>` type), `rows`, `rowKey`,
  `label`, and the sort kept by you (`sort`, `onSortChange`) or by it (`defaultSort`).
  `onRowOpen` makes each row open with a click or Enter, `selectedKey` draws one as chosen,
  `empty` shows when there are no rows, and `maxHeight` gives it its own scroll with the header
  kept in view. Rows whose sort value is missing stay at the end.
- `TreeChart`: the same `TreeNode`s as `TreeList`, drawn top-down as boxes joined by lines, as an
  organisation chart is, with zoom, Fit, scroll or drag to move, and a button under each box that
  opens or folds its children (it says how many are folded). Only the open part is drawn.
  `expanded`/`onExpandedChange` or `defaultExpanded` (the top boxes when left out), `focusId` to
  bring one into view and draw it as chosen, `nodeWidth`, `nodeHeight` and `height`. Children that
  open nothing stand in one column under their box (`stackLeaves`, on by default), and `fit` opens
  it zoomed out to its frame, never below half size.

`Page` also takes `above` (over the title: a back link, a line on where the page sits, or the
tabs it belongs to), `headingLevel` (`2` where the page sits under an `h1` of your own; the look
is the same) and `hideTitleOnPhone` (on a phone the title is left to your own bar, which names the
page already; it stays the heading for a screen reader) and `wide` (the pane's whole width
rather than Settings' reading column, for a page laid out beside a tree of its own).
`SettingRow`'s, `Field`'s and `Toggle`'s `label` and `description` may be more than words (a
code span, a link, a badge or a status beside the name); give a label that isn't a string its
words in `labelText` (its type asks for them), which Settings search, the reset's name and the ⓘ
use. All three take a
`testId` on their row.

For forms:

- `Textarea`: a field of several lines with `Input`'s edge, focus ring and `invalid`, as wide as
  its column, 64 px tall at least (a `min-h-*` of yours wins) and resizable down the page. Every
  `<textarea>` prop goes to it; `rows` sets how tall it opens.
- `Checkbox`: a native checkbox with its `label` and an optional `description` line under it, the
  box on the label's first line at any text size and its name in UI text unless your
  `className` gives another step. Every `<input>` prop (`checked`, `onChange`, `name`,
  `disabled`, `data-testid`) goes to the box and `className` to the row; `onCheckedChange`
  gives the new state, as `Switch` does. Without a `label` it is the bare box, named by your
  `aria-label`, and takes no description.
- `RadioGroup<T>`: one choice out of a list, as a column of native radio buttons with a line
  each: `label` (the group's name for a screen reader) or `labelledBy` (the id of a visible
  heading that names it), `options` (`{ value, label, description?, disabled? }`, the
  `RadioOption<T>` type), `value`, `onChange(value)`, and optional `disabled`, `name` (for a
  form), `autoFocusFirst`, `className` and `testId`.
- `OptionGroup` choices take a `description` (words: it is also the choice's
  `aria-description`) and a `testId` (the `OptionGroupOption<T>` type). When any choice has a
  description, the group draws them as choice cards, side by side where its column is 26 rem or
  wider and one above the next where it is narrower, each with its line and the pick's check, as
  New's autonomy picker is; without, it is the segmented control. Either way it is one Tab stop,
  and the arrow keys, Home and End move the pick. It also takes a `className`.

For code and colour:

- `CodeEditor`: a plain code editor, on the theme's names in light and dark: line numbers, a
  monospace text that scrolls both ways, no syntax colours. Props: `value`, `onChange` (left out,
  it is read only), `label` (its name for a screen reader), and optional `readOnly`, `markers`,
  `tabSize` (2), `onKeyDown`, `className` (give it a height; it scrolls inside) and `testId`.
  `markers` (`{ line, message }`, the `CodeEditorMarker` type, lines from 1) are the host's
  problems: each marked line has a red number and a tint, the list under the editor names them and
  goes to one, and the text is marked invalid. Ctrl or ⌘ F opens Find (case-insensitive; Enter and
  Shift+Enter step, Escape closes it and selects the match). Tab indents and Shift+Tab outdents
  the lines a selection touches; Escape, then Tab, moves on from the editor, and a read-only one
  lets Tab through. `onKeyDown` sees each key first, for a shortcut of yours such as Ctrl+S;
  `preventDefault` stops the editor's own. Its `ref` is a `CodeEditorHandle`: `focus()`,
  `find(query?)`, `closeFind()` and `goToLine(line)`.
- `Diff`: a unified line diff of `before` against `after`: removed lines over the ones that
  replaced them, each with its old and new number, in the diff colours. `words` also marks what
  changed within a changed line paired with the line it replaced. Unchanged lines more than
  `context` (3) from a change fold into a row that opens them; `context="all"` shows every line.
  Past `maxLines` (5000) on either side the texts are not compared and it says `tooLarge`;
  identical texts say `unchanged`. A change too large to match line by line is drawn as removed,
  then added, and words are left out of a line too long to compare. Also `label`, `className`
  and `testId`. `lineDiff(before, after, { words?, maxLines? })` is the same diff as data (the
  `DiffLine` type), for counting what changed.
- `ColorField`: a colour as a hex code: a swatch that opens the system's colour picker, the code
  in a monospace field, and optional preset `swatches`. Props: `value` (`#rrggbb`), `onChange`,
  and optional `label` (the colour's name; the field's and the swatch's accessible name, the
  swatch's saying the current code), `swatches`, `invalid`, `disabled`, `id` (the field's, for a
  `<label htmlFor>` of yours, which then names it), `className` and `testId`. The field takes
  `#rgb` or `#rrggbb`, with or without `#`, and commits it as lowercase `#rrggbb` on Enter or
  when it loses focus; anything else is marked invalid and never reaches `onChange`, and Escape
  puts the value back. `parseHex(text)` is the same check, giving `#rrggbb` or `undefined`.

For what opens over the page:

- `Dialog`: a centred modal, as Gram's are. Mount it to open it, or give `open` to keep it
  mounted so it fades out as it closes. Closing (Esc, the backdrop) calls `onClose`, and focus
  goes back to what had it, or to `returnFocus()` when that is gone. Props: `title`,
  `description?`, `onClose`, `children` (its body and its buttons; a Cancel calls `onClose`), and
  optional `open`, `testId`, `returnFocus`, `initialFocus` and `className` (on the popup). It
  opens a fifth of the way down and scrolls before it runs past the window; focus starts on its
  first control, so for a long body whose first control is at its end, give `initialFocus`.
- `Sheet`: a sheet from the window's end edge, as the workspace sheet is: `open`, `onClose`,
  `title`, `children` (its body, which scrolls, by keyboard too), and optional `description` (a
  line at the top of the body, which describes the dialog), `beside` (after the title: a badge, a
  count), `actions` (in the header, before Close), `wide` (36 rem rather than 28, for a page of
  settings), `testId`, `closeLabel`, `returnFocus` and `className` (on the body). It stays
  mounted while closed, so it slides away with its content. A `Dialog` rendered inside it dims
  it, and a click on the dim only closes the dialog; one rendered beside it covers it with its
  own backdrop.
- `Menu`: a menu hung from a button, with Gram's popup and rows. `Menu` holds a `MenuTrigger`
  (give it a `render`, such as a `Button`) and a `MenuContent` (`side`, `align`, default under
  the trigger at its end, and `sideOffset`). Rows: `MenuItem` (`onClick`, `disabled`, `danger`
  for a removal), `MenuCheckboxItem` (`checked`, `onCheckedChange`; the menu stays open),
  `MenuRadioGroup` (`value`, `onValueChange`) of `MenuRadioItem`s (`value`), `MenuGroup` with a
  `MenuLabel`, `MenuSeparator`, and a submenu as `MenuSub` with a `MenuSubTrigger` and a
  `MenuSubContent`. They take Base UI's Menu props beside these. A menu never runs past the
  window: a long one scrolls and a long row wraps. A row that opens a `Dialog` (a removal's
  confirm) opens it best once the menu has closed, from `Menu`'s `onOpenChangeComplete`, so the
  two don't both hold focus for a moment.

For states and feedback:

- `EmptyState`: what an empty list or page says, as the Board's and the Inbox's do: `icon` (a
  Lucide icon or any glyph taking `className`, the `EmptyIcon` type), `title` (a fragment, "No
  members yet"), `line?` (what goes there, one sentence), `action?` (`{ label, onClick, testId?,
  primary? }`, the `EmptyAction` type: one outline button, filled only where it is the one way in),
  and optional `testId`, `className`, `iconClassName` (only for a glyph whose colour is a status)
  and `children` (after the action).
- `Skeleton`: where something still loading will be, at the size you give it (`className`), in
  the hover fill and pulsing under the Full motion setting only. Hidden from a screen reader.
- `Shimmer`: words for what is still loading ("Loading members…"), a band of light across them
  (`active`, default on; `className`). Gram says what loads in words where it can.
- `Badge` and `Alert` take `variant="success"` and `variant="warning"` beside `destructive`. As
  Gram's own status marks, the tone outlines a neutral fill and colours a badge's words or an
  alert's glyph, never a tinted fill: `success` for done or passing, `warning` for a caution on
  something chosen. Amber that means "needs you" is not `warning`; see the design notes.
- `SettingsGroup` takes `plainOnPhone`: on a phone, a plain list rather than a card, with no
  hairlines between rows and the title a quiet label with a rule running out after it. Wider
  windows keep the card.

For people and agents:

- `Avatar`: someone's or something's mark: `name` (its initials and, when `labelled`, its name to
  a screen reader), `shape` (`round`, the default, for a person; `square` for an agent), `glyph` (a
  Lucide icon or any glyph taking `className`, in place of the initials), `initials`, `size` (`xs`
  20 px, `sm` 28 px, `md` 36 px, the default), `status` (a dot at its corner: `success`,
  `working`, `waiting` as a hollow ring, `needs`, `idle` or `error`, in Gram's status colours and
  still), `statusLabel` (the status in words, for the dot's hover and a screen reader; required
  with a `status`, so a dot never says it by colour alone), `dimmed`,
  `labelled`, `className` and `style` (on the tile, for a fill of your own) and `testId`. Beside its
  name it is hidden from a screen reader. Its tile is on the neutral fill; the dot is ringed in
  `--mark-ground`, the page's background unless you set it.
- `AvatarRow`: a row for a person or an agent: `avatar` (an `Avatar`'s props without `size`, the
  `AvatarMarkProps` type; the row sets the size), `name` (words, or a link of yours), `tags` (after the name: words, or `{ label, look,
  hideOnPhone }` with `look` `quiet`, `badge` for an outlined pill or `code`), `meta` (the line
  under the name), `aside` (muted words before the status, left out under 1024 px), `status` and
  `statusTone` (`default`, `muted`, `success`, `working`, `needs`, `error`; by default from the
  mark's status, `waiting` as `working` and `idle` as `muted`) at the row's end; a mark's
  `statusLabel` is said after the name when the row has no `status` words,
  `compact` (a 28 px mark, less height), `className` and `testId`.
- `TreeList`: entries indented under the one they belong to, with lines joining them and a
  chevron that folds an entry's children: `nodes` (`{ id, label, content?, children? }`, the
  `TreeNode` type; `label` names the chevron and is drawn when there is no `content`), `label` (the
  list's name for a screen reader), `defaultExpanded` (`all`, the default, or the ids to start
  open; an entry added later follows it), or `expanded` with `onExpandedChange` to keep the folds
  yourself, `connectors` (on by default), `className` and `testId`.

The package's declarations (`gram-web-kit.d.ts` and `types/`) type every one of these, `render`
on `Button`, `Badge` and the tooltip's trigger included, so an app needs no declarations of its
own for the kit: resolve `@gram/web/kit` to the package and its `exports` find them. A test
type-checks a page on the kit against exactly what the package ships
([embed-types.test.mjs](../apps/web/scripts/embed-types.test.mjs)).

### Before Gram mounts

A page your app shows before it mounts Gram (a sign-in, a landing page, a boot screen) can look like
Gram without loading it. `@gram/web/kit-lite` has the basics: `Button`, `buttonVariants`,
`ButtonGroup`, `Input`, `InputGroup`, `Textarea`, `Field`, `Checkbox`, `RadioGroup`, `Badge`,
`Alert`, `Skeleton`, `Shimmer` and `cn`. They are the full kit's own controls from the same
sources, with the same props; the light kit's `Field` is Settings' field as it is drawn, without
the search and "Saved" a page of settings adds. `applyGramTheme(theme?, defaults?)` puts the person's
stored look on `<html>` as Gram's own theme sync does once it mounts: their mode, palette (one of
their own palettes too, its colours written for the page), contrast, density and motion, resolved
against the OS's preferences, with your app's `theme` (the one you mount with) over them. So the
page is already in the look Gram will open in. The OS's preferences are read once, as it runs;
call it again to follow a change. Call it on every such page: without it the page draws in
Gram's default dark palette.

```tsx
import { applyGramTheme, Button, Field, Input } from "@gram/web/kit-lite";
import "@gram/web/kit-lite.css";

applyGramTheme(houseTheme);
```

`@gram/web/kit-lite.css` carries Gram's tokens and every palette, its base styles, the Glass look's
fonts (Inter and JetBrains Mono) and the styles of the light kit's controls; your own markup takes
the theme's names from `theme.css` as below. Neither loads any of Gram's app: the light kit is
about 200 kB of code before compression (60 kB after), React aside, and the build fails past its
budget (`kitLiteKb` in `apps/web/bundle-budgets.json`). Once Gram mounts, its own stylesheet and
kit take over; a page that mounts Gram needs only those.

For your own markup, `@gram/web/theme.css` gives a Tailwind 4 build of yours the names of Gram's
theme: its colours (`bg-surface-3`, `text-muted-foreground`), type steps (`text-meta`,
`text-heading`), named spaces (`p-inset`, `gap-section`), icon sizes, variants (`dark:`, `phone:`)
and utilities (`focus-ring`). The values behind the names are the custom properties the app's
stylesheet sets on `<html>`, so your pages follow the person's palette, mode and look.

The type steps are the seven of [the design notes](../DESIGN.md#tokens), and there is no smaller
one: words read for meaning (a time, a state, a chip's word) are `text-meta`, 13 px, and
`text-caption`, 11 px, is only for what is never read for meaning, such as a key cap or a count.
A class outside the scale, such as `text-micro`, writes no style at all.

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

The server an embedding app runs may be older than the web it mounts. The web's first call on
its socket is `app.handshake`, which answers with the server's version and every RPC it serves.
Calls wait for that answer, and one the server lacks fails at once with `NotImplemented` without
being sent. A server older than the handshake refuses unknown RPCs at once (a defect for the
tag), which the web turns into the same `NotImplemented` and remembers. A control backed by a
missing RPC is hidden, or greyed with a hover text (`useServes`). A new RPC behind a control
gets the same check.

Embedding work lands on the `integration/embedding` branch, which takes `main` by merge. A UI
change merged to `main` reaches embedders only after that merge, so merge `main` in soon after
one lands, and carry its "Embedders" line into the merge's description.

## Limits today

- Layout, drafts and theme are kept in the browser's storage for the origin, not per server. Two
  servers shown from one origin share them. With `appearance: "server"` (the default) each server's
  saved look still replaces the stored theme when the app starts against it.
- The browser tab's title is Gram's.

## Checking it

`bun run --filter @gram/web e2e:embed` builds the package, builds a
[separate app](../apps/web/e2e-embed/fixture/src/main.tsx) that consumes only the build, and
drives it in a browser: the whole app mounts, an added page opens from the sidebar, the palette
and its address and is named in the title bar and on a phone, the switcher moves between the
sidebar and the title bar, pages of its own use the kit (a page of settings among them, and a
menu and submenu taller than the window, which scroll in place) and the theme's names, and all of
it works
under a base path. CI runs it in the first e2e shard.
