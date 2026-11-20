// A stand-in for an app in front of Gram: it mounts the built package (`dist-embed`) against the
// in-memory server and adds two pages, a navigation group and a switcher, as docs/EMBEDDED_WEB_APP.md
// describes. Opened under `/w/acme`, it serves the app under that path.
import {
  mountGram,
  ShellLink,
  ShellThread,
  ShellThreadPanel,
  useShellLocation,
  type GramHandle,
  type ShellPageProps,
  type ShellSlotProps,
} from "gram-web";
import {
  Avatar,
  AvatarRow,
  Badge,
  Button,
  CodeEditor,
  ColorField,
  Diff,
  Hint,
  Menu,
  MenuContent,
  MenuItem,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Input,
  InputGroup,
  Meter,
  OptionGroup,
  Page,
  Popover,
  SettingRow,
  SettingsGroup,
  TreeList,
  type CodeEditorHandle,
  type TreeNode,
} from "gram-web/kit";
import { Bot } from "lucide-react";
import "gram-web/style.css";
import { useRef, useState } from "react";

import "./style.css";

declare global {
  interface Window {
    /** The mount's handle, for the specs. */
    embed?: GramHandle;
    /** The threads whose Try again asked this page for another machine, in order. */
    embedStartedAgain?: string[];
  }
}

function Policies() {
  const { pathname, navigate } = useShellLocation();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-section px-5 py-6">
      <header className="flex items-center gap-2">
        <h1 data-testid="fixture-policies" className="font-heading text-heading">
          Policies
        </h1>
        <Badge variant="secondary">2 active</Badge>
      </header>
      {/* Classes of this app's own Tailwind build, on the names of Gram's theme. */}
      <p
        data-testid="fixture-themed"
        className="rounded-md bg-surface-3 p-inset text-meta text-muted-foreground"
      >
        This page is at <span data-testid="fixture-pathname">{pathname}</span>
      </p>
      <div className="flex items-center gap-2">
        <Hint
          label="Opens Gram's own About page"
          render={
            <Button
              data-testid="fixture-button"
              variant="outline"
              size="sm"
              onClick={() => void navigate("/settings/about")}
            />
          }
        >
          About Gram
        </Hint>
        <ShellLink to="/govern/agents/a-42" className="text-link underline">
          Agent 42
        </ShellLink>
        {/* A page sending the window on, as a redirect does: Back skips it. */}
        <Button
          data-testid="fixture-replace"
          variant="ghost"
          size="sm"
          onClick={() => void navigate("/govern/limits", { replace: true })}
        >
          Limits instead
        </Button>
      </div>
    </div>
  );
}

type Period = "day" | "month";

/** A page of settings built from the kit's pieces, as Settings' own are. */
function Limits() {
  const [cap, setCap] = useState("500");
  const [period, setPeriod] = useState<Period>("month");
  const invalid = !/^\d+$/.test(cap);
  return (
    <Page
      title="Limits"
      description="What the organisation may spend."
      hideTitleOnPhone
      actions={
        <Popover
          label="Organisations"
          testId="fixture-popover"
          trigger={
            <Button data-testid="fixture-popover-trigger" variant="outline" size="sm">
              Acme
            </Button>
          }
        >
          <div className="p-2 text-body">Acme / Data</div>
        </Popover>
      }
    >
      <SettingsGroup label="Spend" description="A cap on what agents spend." testId="fixture-group">
        <SettingRow
          label="Cap"
          description="In dollars, for each period."
          htmlFor="fixture-cap"
          error={invalid ? "A whole number of dollars" : undefined}
        >
          <InputGroup prefix="$" suffix={`per ${period}`}>
            <Input
              id="fixture-cap"
              data-testid="fixture-cap"
              className="w-24"
              value={cap}
              invalid={invalid}
              onChange={(event) => setCap(event.target.value)}
            />
          </InputGroup>
        </SettingRow>
        <SettingRow label="Period">
          <OptionGroup<Period>
            label="Period"
            options={[
              { value: "day", label: "Day" },
              { value: "month", label: "Month" },
            ]}
            value={period}
            onChange={setPeriod}
          />
        </SettingRow>
        <SettingRow label="Used this month">
          <Meter value={0.95} label="Used this month" className="w-40" fillTestId="fixture-meter" />
        </SettingRow>
      </SettingsGroup>
    </Page>
  );
}

/** Forty-five members: more rows than any window holds, and one name longer than a phone. */
const MEMBERS = Array.from({ length: 45 }, (_, index) =>
  index === 0
    ? "Member 1, whose name is far longer than a phone is wide and has to wrap inside the menu"
    : `Member ${index + 1}`,
);

/** A page with a menu and a submenu far taller than the window, which have to scroll in place. */
function Members() {
  return (
    <div className="flex justify-end p-6">
      <Menu>
        <MenuTrigger
          render={<Button data-testid="fixture-long-menu" variant="outline" size="sm" />}
        >
          Members
        </MenuTrigger>
        <MenuContent data-testid="fixture-long-menu-popup">
          <MenuSub>
            <MenuSubTrigger data-testid="fixture-long-submenu">Everyone</MenuSubTrigger>
            <MenuSubContent data-testid="fixture-long-submenu-popup">
              {MEMBERS.map((name) => (
                <MenuItem key={name}>{name}</MenuItem>
              ))}
            </MenuSubContent>
          </MenuSub>
          {MEMBERS.map((name) => (
            <MenuItem key={name}>{name}</MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

/** A person in the tree, as a row. */
const person = (id: string, name: string, title: string, online: boolean): TreeNode => ({
  id,
  label: name,
  content: (
    <AvatarRow
      testId="fixture-person"
      avatar={{
        name,
        ...(online ? { status: "success" as const, statusLabel: "Online" } : { dimmed: true }),
      }}
      name={name}
      meta={title}
      status={online ? "Online" : "Seen yesterday"}
      statusTone={online ? "default" : "muted"}
    />
  ),
});

/** The kit's marks, rows and tree, with made-up people and agents. */
function People() {
  const tree: readonly TreeNode[] = [
    {
      id: "north",
      label: "North",
      content: <span className="text-body-strong">North</span>,
      children: [
        person("ada", "Ada Example", "Lead", true),
        {
          id: "east",
          label: "East",
          content: <span className="text-body-strong">East</span>,
          children: [
            person("bo", "Bo Sample", "Engineer", true),
            person("cy", "Cy Placeholder", "Engineer", false),
          ],
        },
      ],
    },
  ];
  return (
    <Page title="People" description="Marks, rows and a tree from the kit.">
      <div data-testid="fixture-marks" className="flex flex-wrap items-center gap-4">
        <Avatar name="Ada Example" size="xs" status="success" statusLabel="Online" />
        <Avatar name="Ada Example" size="sm" status="idle" statusLabel="Away" />
        <Avatar name="Ada Example" status="success" statusLabel="Online" labelled />
        <Avatar name="Build bot" shape="square" glyph={Bot} size="xs" status="working" />
        <Avatar name="Build bot" shape="square" glyph={Bot} size="sm" status="waiting" />
        <Avatar name="Build bot" shape="square" glyph={Bot} status="needs" />
        <Avatar name="Build bot" shape="square" glyph={Bot} status="error" dimmed />
      </div>
      <div className="flex flex-col divide-y divide-border">
        <AvatarRow
          testId="fixture-agent-row"
          avatar={{ name: "Build bot", shape: "square", glyph: Bot, status: "working" }}
          name="Build bot"
          tags={[
            { label: "Shared", look: "badge" },
            { label: "bot/build", look: "code", hideOnPhone: true },
          ]}
          meta="Owned by Ada Example · acts through two accounts"
          aside="Writing the release notes"
          status="Working"
          statusTone="working"
        />
        <AvatarRow
          avatar={{ name: "Ada Example", status: "success" }}
          name="Ada Example"
          tags={["You", "Lead"]}
          meta="Lead"
          status="Online"
        />
        <AvatarRow
          compact
          avatar={{ name: "Check bot", shape: "square", glyph: Bot, status: "needs" }}
          name="Check bot"
          meta="Waiting on a review"
          status="Waiting on someone"
          statusTone="needs"
        />
      </div>
      <TreeList testId="fixture-tree" label="Teams" nodes={tree} />
    </Page>
  );
}

/** A group whose heading opens a page, its rows marks with a status. */
(window as unknown as { fixturePeopleNav: unknown }).fixturePeopleNav = {
  id: "people",
  label: "People",
  to: "/govern/people",
  placement: "main",
  collapsible: true,
  items: [
    {
      id: "build-bot",
      label: "Build bot",
      to: "/govern/agents/build-bot",
      mark: { shape: "square", glyph: Bot, status: "working", statusLabel: "Working" },
    },
    {
      id: "ada",
      label: "Ada Example",
      to: "/govern/agents/ada",
      mark: { status: "success", statusLabel: "Online" },
    },
  ],
};

/** This app's own first page, at the app's root in place of Gram's. */
function Home() {
  return (
    <Page title="Welcome to Acme" description="Your places, then your threads.">
      <p data-testid="fixture-home" className="text-body text-muted-foreground">
        Pick a place on the left.
      </p>
    </Page>
  );
}

function Agent({ params }: ShellPageProps) {
  return (
    <div className="p-6">
      <h1 data-testid="fixture-agent">Agent {params["agentId"]}</h1>
    </div>
  );
}

function Switcher({ placement }: ShellSlotProps) {
  const [picked, setPicked] = useState("Acme / Platform");
  return (
    <button
      type="button"
      data-testid="fixture-switcher"
      onClick={() =>
        setPicked((now) => (now === "Acme / Platform" ? "Acme / Data" : "Acme / Platform"))
      }
    >
      {placement === "rail" ? picked.slice(0, 1) : picked}
    </button>
  );
}

/** The sidebar's head: a mark and the app's name. */
function Brand() {
  return (
    <span data-testid="fixture-brand" className="flex min-w-0 items-center gap-2.5 px-1">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-(--radius-sm) border border-border text-meta font-semibold"
      >
        F
      </span>
      <span className="truncate text-title font-semibold">Fixture</span>
    </span>
  );
}

/** The person signed in, at the sidebar's foot. */
function Account() {
  return (
    <span data-testid="fixture-account" className="flex min-w-0 items-center gap-3 px-1">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-meta font-semibold text-background"
      >
        I
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body-strong">Ingrid Example</span>
        <span className="truncate text-caption text-muted-foreground">Signed in</span>
      </span>
    </span>
  );
}

/** The roomy look with both slots, for the run to put on through `update`. */
(window as unknown as { fixtureSidebar: unknown }).fixtureSidebar = {
  look: "roomy",
  header: Brand,
  account: Account,
  accountName: "Ingrid",
};

const pathUnder =
  location.pathname === "/w/acme" || location.pathname.startsWith("/w/acme/")
    ? "/w/acme"
    : undefined;

const element = document.getElementById("root");
if (element === null) throw new Error("#root element missing");

const GOVERN = {
  id: "govern",
  label: "Govern",
  items: [
    { id: "policies", label: "Policies", to: "/govern/policies" },
    { id: "limits", label: "Limits", to: "/govern/limits" },
    { id: "usage", label: "Spend", to: "/usage" },
  ],
};

// The places this app works in, at the top of the sidebar: a count of what waits on one.
const BUILD = {
  id: "build",
  label: "Build",
  placement: "main" as const,
  items: [
    { id: "home", label: "Home", to: "/" },
    { id: "runs", label: "Runs", to: "/govern/agents/a-1", count: 3 },
    { id: "threads", label: "Threads", to: "/threads" },
  ],
};

/** A page of the app's with one of Gram's threads beside its own content. */
function Beside({ params }: ShellPageProps) {
  return (
    <div className="flex h-full min-h-0">
      <p className="flex-1 p-6" data-testid="beside-own">
        The app's own page
      </p>
      <aside className="flex w-96 min-w-0 flex-col border-l border-border">
        <ShellThread threadId={params["threadId"] ?? ""} />
      </aside>
    </div>
  );
}

const SOURCE = [
  "export function total(items) {",
  "  let sum = 0;",
  "  for (const item of items) sum += item.price;",
  "  return sum",
  "}",
  "",
  "export const label = (sum) => `Total: ${sum}`;",
].join("\n");

/** A page of the app's with the kit's code editor, a diff against what it started from, and a colour field. */
function Source() {
  const [code, setCode] = useState(SOURCE);
  const [accent, setAccent] = useState("#3366cc");
  const editor = useRef<CodeEditorHandle>(null);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-section px-5 py-6">
      <h1 className="font-heading text-heading">Source</h1>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => editor.current?.find("item")}>
          Find item
        </Button>
      </div>
      <CodeEditor
        ref={editor}
        label="Code of total.js"
        value={code}
        onChange={setCode}
        markers={[{ line: 4, message: "Missing semicolon." }]}
        className="h-64"
        testId="fixture-editor"
      />
      <Diff before={SOURCE} after={code} words label="Your changes" testId="fixture-diff" />
      <ColorField
        label="Accent"
        value={accent}
        onChange={setAccent}
        swatches={["#3366cc", "#cc3366", "#2e9e5b"]}
        testId="fixture-color"
      />
      <p data-testid="fixture-accent">{accent}</p>
    </div>
  );
}

/** A page of the app's with a thread's working panels beside the thread. */
function Changes({ params }: ShellPageProps) {
  const threadId = params["threadId"] ?? "";
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-96 min-w-0 flex-col border-r border-border">
        <ShellThread threadId={threadId} placeholder="Message this worker…" />
      </div>
      <div className="min-w-0 flex-1">
        <ShellThreadPanel threadId={threadId} />
      </div>
    </div>
  );
}

mountGram({
  element,
  // A conversation of the page's own, at an id the page chose.
  mockThreads: [
    {
      id: "page-notes",
      title: "Notes from the page",
      messages: [
        { role: "user", text: "What did the nightly sweep close?" },
        { role: "assistant", text: "Three stale issues, all older than ninety days." },
      ],
    },
    // Started before its machine, and none came: its Try again asks this page for another. Only
    // for the spec that asks, since a thread that needs someone leads every list.
    ...(new URLSearchParams(location.search).has("waiting-thread")
      ? [
          {
            id: "page-waiting",
            title: "Release notes",
            messages: [{ role: "user" as const, text: "Draft the release notes for 2.4." }],
            awaitingMachine: { failed: "The machine couldn't be started: no capacity." },
          },
        ]
      : []),
  ],
  server: new URLSearchParams(location.search).has("session-test")
    ? {
        base: "/cell/",
        session: {
          refresh: async () => (await fetch("/renew", { method: "POST" })).ok,
          expired: () => {
            document.body.textContent = "Sign in to the host app";
          },
        },
      }
    : "mock",
  ...(pathUnder === undefined ? {} : { basePath: pathUnder }),
  ...(new URLSearchParams(location.search).has("inset-sidebar")
    ? {
        theme: {
          sidebar: {
            mode: "inset" as const,
            icon: { dark: "rgb(214, 160, 92)", light: "rgb(156, 92, 34)" },
          },
        },
      }
    : {}),
  // The navigation's default: `?nav=dock-top`, `?nav=dock-bottom` or `?nav=side`, and `&auto-hide`.
  ...(new URLSearchParams(location.search).has("nav") ||
  new URLSearchParams(location.search).has("auto-hide")
    ? {
        defaults: {
          navigation: {
            ...(new URLSearchParams(location.search).get("nav")?.startsWith("dock")
              ? {
                  position: "dock" as const,
                  edge:
                    new URLSearchParams(location.search).get("nav") === "dock-top"
                      ? ("top" as const)
                      : ("bottom" as const),
                }
              : { position: "side" as const }),
            autoHide: new URLSearchParams(location.search).has("auto-hide"),
          },
        },
      }
    : {}),
  // An app that follows Gram's palettes and picks its default look by name only.
  ...(new URLSearchParams(location.search).has("look-defaults")
    ? {
        defaults: {
          palette: "petrol-dark",
          accent: "plum",
          sidebar: "inset",
          sidebarIcons: "accent",
          backdrop: "fjord",
          surfaces: "frosted",
        } as const,
      }
    : {}),
  shell: {
    machines: {
      // What a real app hands to its own service, which begins the wait again and starts a machine.
      startAgain: ({ threadId }) => {
        window.embedStartedAgain = [...(window.embedStartedAgain ?? []), threadId];
      },
    },
    routes: [
      { path: "/govern/policies", title: "Policies", component: Policies },
      { path: "/govern/limits", title: "Limits", component: Limits },
      { path: "/govern/members", title: "Members", component: Members },
      { path: "/govern/agents/$agentId", component: Agent },
      { path: "/govern/beside/$threadId", title: "Beside", component: Beside },
      { path: "/govern/changes/$threadId", title: "Changes", component: Changes },
      { path: "/govern/source", title: "Source", component: Source },
      { path: "/govern/people", title: "People", component: People },
    ],
    home: { title: "Home", component: Home },
    navigation: [BUILD, GOVERN],
    workspaceSwitcher: Switcher,
    // `?switcher-titlebar`: the switcher kept to the title bar, out of the navigation.
    ...(new URLSearchParams(location.search).has("switcher-titlebar")
      ? { sidebar: { switcher: "titlebar" as const } }
      : {}),
  },
})
  .then((handle) => {
    window.embed = handle;
    document.documentElement.dataset["embedShell"] = handle.shell;
  })
  .catch((error: unknown) => {
    document.documentElement.dataset["embedError"] = String(error);
    throw error;
  });
