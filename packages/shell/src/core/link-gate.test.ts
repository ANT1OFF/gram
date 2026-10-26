import { describe, expect, it } from "vitest";

import { createLinkGate, linkPrompt, type LinkAnswer, type LinkPrompt } from "./link-gate.ts";

const setup = (stored: unknown, answers: LinkAnswer[] = []) => {
  const opened: string[] = [];
  const copied: string[] = [];
  const asked: LinkPrompt[] = [];
  const saved: (readonly string[])[] = [];
  const changed: (readonly string[])[] = [];
  const gate = createLinkGate<"win">({
    load: () => stored,
    save: (hosts) => saved.push(hosts),
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? { action: "cancel", trust: false };
    },
    open: async (url) => {
      opened.push(url);
    },
    copy: (text) => copied.push(text),
    changed: (hosts) => changed.push(hosts),
  });
  return { gate, opened, copied, asked, saved, changed };
};

describe("link gate", () => {
  it("opens a trusted host without asking, and asks for anything else", async () => {
    const { gate, opened, asked } = setup(["docs.example.com"]);
    expect(await gate.open("https://docs.example.com/wiki")).toBe(true);
    expect(await gate.open("https://evil.example.com/wiki")).toBe(false);
    expect(await gate.open("https://docs.example.com@evil.com/")).toBe(false);
    expect(opened).toEqual(["https://docs.example.com/wiki"]);
    expect(asked.map((p) => p.message)).toEqual([
      "Open a link to evil.example.com?",
      "Open a link to evil.com?",
    ]);
  });

  it("trusts a host from the dialog's checkbox, and stops when it's removed", async () => {
    const { gate, opened, asked, saved, changed } = setup(undefined, [
      { action: "open", trust: true },
    ]);
    expect(await gate.open("https://docs.example.com/a")).toBe(true);
    expect(await gate.open("https://docs.example.com/b")).toBe(true);
    expect(asked).toHaveLength(1);
    expect(gate.hosts()).toEqual(["docs.example.com"]);
    expect(saved).toEqual([["docs.example.com"]]);

    gate.remove("docs.example.com");
    expect(await gate.open("https://docs.example.com/c")).toBe(false);
    expect(asked).toHaveLength(2);
    expect(opened).toEqual(["https://docs.example.com/a", "https://docs.example.com/b"]);
    expect(changed).toEqual([["docs.example.com"], []]);
  });

  it("never trusts a link that always asks, even with the box ticked", async () => {
    const { gate, opened } = setup(
      [],
      [
        { action: "open", trust: true },
        { action: "open", trust: true },
        { action: "open", trust: true },
      ],
    );
    await gate.open("http://organization.example.invalid/");
    await gate.open("https://me@organization.example.invalid/");
    await gate.open("https://organization.example.invalid:8443/");
    expect(opened).toHaveLength(3);
    expect(gate.hosts()).toEqual([]);
  });

  it("opens nothing that isn't http(s), and never asks about it", async () => {
    const { gate, asked, opened } = setup(
      ["organization.example.invalid"],
      [{ action: "open", trust: false }],
    );
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "mailto:a@organization.example.invalid",
    ]) {
      expect(await gate.open(url)).toBe(false);
    }
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("copies instead of opening when asked to", async () => {
    const { gate, opened, copied } = setup([], [{ action: "copy", trust: true }]);
    expect(await gate.open("https://organization.example.invalid/x")).toBe(false);
    expect(copied).toEqual(["https://organization.example.invalid/x"]);
    expect(opened).toEqual([]);
    expect(gate.hosts()).toEqual([]);
  });

  it("asks one link at a time, so a host trusted first opens the ones behind it", async () => {
    const { gate, asked, opened } = setup([], [{ action: "open", trust: true }]);
    const all = await Promise.all([
      gate.open("https://organization.example.invalid/1"),
      gate.open("https://organization.example.invalid/2"),
      gate.open("https://organization.example.invalid/3"),
    ]);
    expect(all).toEqual([true, true, true]);
    expect(asked).toHaveLength(1);
    expect(opened).toEqual([
      "https://organization.example.invalid/1",
      "https://organization.example.invalid/2",
      "https://organization.example.invalid/3",
    ]);
  });

  it("ignores stored entries that aren't exact hosts", () => {
    const { gate } = setup([
      "*.organization.example.invalid",
      "organization.example.invalid",
      "organization.example.invalid:8443",
      "organization.example.invalid",
      7,
    ]);
    expect(gate.hosts()).toEqual(["organization.example.invalid"]);
  });
});

describe("linkPrompt", () => {
  it("leads with the host, then the whole link, and offers always-open", () => {
    expect(linkPrompt("https://docs.example.com/wiki", { host: "docs.example.com" })).toEqual({
      title: "Open external link?",
      message: "Open a link to docs.example.com?",
      detail: "https://docs.example.com/wiki",
      checkboxLabel: "Always open links to docs.example.com without asking",
    });
  });

  it("names the punycode host beside the written one, and says why a link always asks", () => {
    const idn = linkPrompt("https://dоcs.example.com/", {
      host: "xn--dcs-sed.example.com",
      written: "dоcs.example.com",
    });
    expect(idn.message).toBe("Open a link to xn--dcs-sed.example.com?");
    expect(idn.detail).toContain("the browser goes to xn--dcs-sed.example.com");
    // As it arrives from the renderer: punycode only, spelled out again for the dialog.
    expect(
      linkPrompt("https://xn--dcs-sed.example.com/", { host: "xn--dcs-sed.example.com" }).detail,
    ).toContain("spells the site “dоcs.example.com”");

    const userinfo = linkPrompt("https://docs.example.com@evil.com/", {
      host: "evil.com",
      untrustable: "userinfo",
    });
    expect(userinfo.message).toBe("Open a link to evil.com?");
    expect(userinfo.detail).toContain("user name, not the site");
    expect(userinfo.checkboxLabel).toBeUndefined();
  });
});
