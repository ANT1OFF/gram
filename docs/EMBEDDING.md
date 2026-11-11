# Mounting Gram in another app

[Up: documentation map](README.md)

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
`update` replaces the navigation and the switcher, `navigate` moves the window to a path under the
app, and `unmount` takes the app off the page.

## What you can add

**Pages.** Each of `routes` is a path and a React component. The page is drawn in the
conversation's place, with Gram's sidebar and title bar around it, and scrolls on its own. A path
is written the way Gram's router writes them (`/agents/$agentId`), and the component is given the
parameters as `params`. A path that Gram has itself (`/`, `/t`, `/w`, `/new`, `/new-task`,
`/new-workspace`, `/settings`, `/usage`) is refused when the app mounts, as is one added twice.
Routes are read once, at mount.

**Navigation groups.** Each group is a heading and its destinations. They are listed at the foot
of the sidebar above History, in the phone's drawer, as icons in the compact sidebar (a
destination without an `icon` shows its first letter), and in the command palette under the
group's name. A destination's `to` may be one of your pages or one of Gram's.

**A switcher.** `workspaceSwitcher` is a component of yours, for whatever your app switches
between: organisations, or workspaces that live on other Gram servers. It is drawn at the head of
the sidebar, as a tile in the compact sidebar, and at the start of the title bar while the sidebar
is hidden; `placement` tells it which. Gram's own workspace switcher stays where it is and lists
the workspaces of the one server.

Inside your pages and switcher, `ShellLink` is a link to a path under the app that doesn't load
the page again, and `useShellLocation()` gives the path the window is on (without `basePath`) and
a `navigate`.

## Limits today

- Your pages bring their own styles. Gram's colour and spacing tokens are CSS custom properties on
  `<html>` and can be read from them; Gram's components are not yet exported.
- Layout, drafts and theme are kept in the browser's storage for the origin, not per server. Two
  servers shown from one origin share them.
- The title of the window is Gram's.

## Checking it

`bun run --filter @gram/web e2e:embed` builds the package, builds a
[separate app](../apps/web/e2e-embed/fixture/src/main.tsx) that consumes only the build, and
drives it in a browser: the whole app mounts, an added page opens from the sidebar, the palette
and its address, the switcher moves between the sidebar and the title bar, and all of it works
under a base path. CI runs it in the first e2e shard.
