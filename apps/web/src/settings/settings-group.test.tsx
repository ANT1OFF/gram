// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { SettingsGroup } from "./settings-group";

afterEach(cleanup);

const mount = (plainOnPhone?: boolean) =>
  render(
    <TooltipProvider>
      <SettingsGroup
        label="Members"
        description="Who can see this."
        testId="members"
        {...(plainOnPhone === undefined ? {} : { plainOnPhone })}
      >
        <div>Ada</div>
        <div>Grace</div>
      </SettingsGroup>
    </TooltipProvider>,
  );

describe("SettingsGroup", () => {
  it("is a titled card everywhere by default", () => {
    mount();
    const card = screen.getByTestId("members");
    expect(card.className).toContain("bg-card");
    expect(card.className).not.toContain("phone:");
    expect(screen.getByRole("heading", { name: "Members" }).className).not.toContain("phone:");
  });

  it("is a plain list on a phone when asked, and still the card wider", () => {
    mount(true);
    const card = screen.getByTestId("members");
    expect(card.className).toContain("bg-card");
    for (const plain of [
      "phone:bg-transparent!",
      "phone:border-0!",
      "phone:[&>*]:border-t-0!",
      "phone:[&>*]:px-0!",
    ])
      expect(card.className).toContain(plain);
    const title = screen.getByRole("heading", { name: "Members" });
    expect(title.className).toContain("phone:text-body!");
    expect(title.className).toContain("phone:text-muted-foreground!");
    // The rule after the title, on the caption's line.
    expect(title.parentElement!.parentElement!.className).toContain("phone:after:bg-border");
    expect(screen.getByRole("region", { name: "Members" }).className).toContain("phone:gap-0!");
  });
});
