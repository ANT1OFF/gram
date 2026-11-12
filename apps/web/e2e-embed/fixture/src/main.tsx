// A stand-in for an app in front of Gram: it mounts the built package (`dist-embed`) against the
// in-memory server and adds two pages, a navigation group and a switcher, as docs/EMBEDDED_WEB_APP.md
// describes. Opened under `/w/acme`, it serves the app under that path.
import {
  mountGram,
  ShellLink,
  ShellThread,
  useShellLocation,
  type GramHandle,
  type ShellPageProps,
  type ShellSlotProps,
} from "gram-web";
import {
  Badge,
  Button,
  Hint,
  Input,
  InputGroup,
  Meter,
  OptionGroup,
  Page,
  Popover,
  SettingRow,
  SettingsGroup,
} from "gram-web/kit";
import "gram-web/style.css";
import { useState } from "react";

import "./style.css";

declare global {
  interface Window {
    /** The mount's handle, for the specs. */
    embed?: GramHandle;
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

mountGram({
  element,
  server: "mock",
  ...(pathUnder === undefined ? {} : { basePath: pathUnder }),
  shell: {
    routes: [
      { path: "/govern/policies", title: "Policies", component: Policies },
      { path: "/govern/limits", title: "Limits", component: Limits },
      { path: "/govern/agents/$agentId", component: Agent },
      { path: "/govern/beside/$threadId", title: "Beside", component: Beside },
    ],
    home: { title: "Home", component: Home },
    navigation: [BUILD, GOVERN],
    workspaceSwitcher: Switcher,
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
