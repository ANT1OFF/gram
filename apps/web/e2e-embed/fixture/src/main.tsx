// A stand-in for an app in front of Gram: it mounts the built package (`dist-embed`) against the
// in-memory server and adds two pages, a navigation group and a switcher, as docs/EMBEDDED_WEB_APP.md
// describes. Opened under `/w/acme`, it serves the app under that path.
import {
  mountGram,
  ShellLink,
  useShellLocation,
  type GramHandle,
  type ShellPageProps,
  type ShellSlotProps,
} from "gram-web";
import { Badge, Button, Hint } from "gram-web/kit";
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
    { id: "usage", label: "Spend", to: "/usage" },
  ],
};

mountGram({
  element,
  server: "mock",
  ...(pathUnder === undefined ? {} : { basePath: pathUnder }),
  shell: {
    routes: [
      { path: "/govern/policies", component: Policies },
      { path: "/govern/agents/$agentId", component: Agent },
    ],
    navigation: [GOVERN],
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
