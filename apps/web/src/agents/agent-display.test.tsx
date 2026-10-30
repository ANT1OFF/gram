// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AGENT_DISPLAY, AgentIcon, agentLabel } from "./agent-display";
import { AGENT_LABEL, agentLabel as pureAgentLabel } from "./agent-label";

afterEach(cleanup);

describe("agentLabel", () => {
  it("names every agent kind, and passes an unknown one through", () => {
    expect(Object.keys(AGENT_DISPLAY)).toEqual(["claude", "codex"]);
    expect(agentLabel("codex")).toBe("Codex");
    expect(agentLabel("claude")).toBe("Claude Code");
    expect(agentLabel("unknown-agent")).toBe("unknown-agent");
    expect(agentLabel("toString")).toBe("toString");
  });

  it("is the one name the pure models use too", () => {
    expect(agentLabel).toBe(pureAgentLabel);
    for (const [agent, { label }] of Object.entries(AGENT_DISPLAY)) {
      expect(label).toBe(AGENT_LABEL[agent as keyof typeof AGENT_LABEL]);
    }
  });
});

const drawing = (agent: string) => {
  const { container } = render(<AgentIcon agent={agent} />);
  const svg = container.querySelector("svg")!;
  cleanup();
  return svg;
};

describe("AgentIcon", () => {
  it("draws each kind its own mark, in the text colour", () => {
    const drawn = Object.keys(AGENT_DISPLAY).map((agent) => drawing(agent).innerHTML);
    expect(new Set(drawn).size).toBe(drawn.length);
    for (const agent of ["claude", "codex"]) {
      const svg = drawing(agent);
      expect(svg.getAttribute("fill")).toBe("currentColor");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    }
  });

  it("draws every kind it doesn't know as the same plug", () => {
    const plug = drawing("unknown-agent").innerHTML;
    expect(drawing("toString").innerHTML).toBe(plug);
    for (const agent of Object.keys(AGENT_DISPLAY)) expect(drawing(agent).innerHTML).not.toBe(plug);
  });

  it("is decorative beside a name, and the name where it stands alone", () => {
    expect(drawing("codex").getAttribute("aria-hidden")).toBe("true");
    for (const [agent, name] of [
      ["claude", "Claude Code"],
      ["codex", "Codex"],
      ["unknown-agent", "unknown-agent"],
    ] as const) {
      render(<AgentIcon agent={agent} labelled />);
      expect(screen.getByRole("img", { name }).hasAttribute("aria-hidden")).toBe(false);
      cleanup();
    }
  });
});
