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
import "gram-web/style.css";
import { useState } from "react";

declare global {
  interface Window {
    /** The mount's handle, for the specs. */
    embed?: GramHandle;
  }
}

function Policies() {
  const { pathname, navigate } = useShellLocation();
  return (
    <div className="p-6">
      <h1 data-testid="fixture-policies">Policies</h1>
      <p data-testid="fixture-pathname">{pathname}</p>
      <ShellLink to="/govern/agents/a-42">Agent 42</ShellLink>
      <button type="button" onClick={() => void navigate("/settings/about")}>
        About Gram
      </button>
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
