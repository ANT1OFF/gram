import { Settings as Gear } from "lucide-react";
import { describe, expect, it } from "vitest";

import { settingsGroupsShown, settingsPagesShown } from "./pages";

const Empty = () => null;
const account = {
  id: "account",
  label: "Account",
  icon: Gear,
  description: "Who you are signed in as.",
  component: Empty,
};

describe("Settings in front of an embedding app", () => {
  it("shows every page of Gram's on its own", () => {
    const pages = settingsPagesShown({});
    expect(pages.map((page) => page.id)).toContain("machines");
    expect(settingsGroupsShown({}).map((group) => group.id)[0]).toBe("general");
  });

  it("lists the app's own pages first, then the ones of Gram's it keeps", () => {
    const settings = { gram: ["appearance", "keyboard"], pages: [account] };
    expect(settingsPagesShown(settings).map((page) => page.id)).toEqual([
      "account",
      "appearance",
      "keyboard",
    ]);
    expect(settingsGroupsShown(settings).map((group) => [group.id, group.path])).toEqual([
      ["host:account", "/settings/account"],
      ["appearance", "/settings/appearance"],
      ["keyboard", "/settings/keyboard"],
    ]);
  });

  it("keeps a page that opens from another only with it", () => {
    expect(settingsPagesShown({ gram: ["terminal"] }).map((page) => page.id)).toEqual([]);
    expect(settingsPagesShown({ gram: ["appearance"] }).map((page) => page.id)).toEqual([
      "appearance",
    ]);
  });

  it("refuses an own page that takes one of Gram's ids, a bad id or the same id twice", () => {
    const pages = [
      { ...account, id: "usage" },
      { ...account, id: "Bad id" },
      account,
      { ...account, label: "Again" },
    ];
    expect(settingsPagesShown({ gram: [], pages }).map((page) => page.label)).toEqual(["Account"]);
  });
});
