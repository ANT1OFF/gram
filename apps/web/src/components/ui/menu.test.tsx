// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./menu";

afterEach(cleanup);

function Harness({ onRename, onRemove }: { onRename: () => void; onRemove: () => void }) {
  const [pinned, setPinned] = useState(false);
  const [sort, setSort] = useState("name");
  return (
    <Menu>
      <MenuTrigger render={<button type="button" />}>Member actions</MenuTrigger>
      <MenuContent data-testid="member-menu">
        <MenuGroup>
          <MenuLabel>Member</MenuLabel>
          <MenuItem onClick={onRename}>Rename</MenuItem>
          <MenuItem danger onClick={onRemove}>
            Remove
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>
          Pinned
        </MenuCheckboxItem>
        <MenuRadioGroup value={sort} onValueChange={setSort}>
          <MenuRadioItem value="name">By name</MenuRadioItem>
          <MenuRadioItem value="role">By role</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Member actions" }));
  return screen.findByTestId("member-menu");
};

describe("Menu", () => {
  it("opens from its trigger with Gram's menu popup and rows", async () => {
    render(<Harness onRename={() => {}} onRemove={() => {}} />);
    const popup = await open();
    expect(popup.getAttribute("role")).toBe("menu");
    expect(popup.getAttribute("data-surface")).toBe("overlay");
    expect(popup.className).toContain("shadow-overlay");
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    expect(rename.className).toContain("data-[highlighted]:row-cursor");
    expect(rename.className).not.toContain("text-destructive");
    expect(screen.getByRole("menuitem", { name: "Remove" }).className).toContain(
      "text-destructive",
    );
    expect(screen.getByRole("group", { name: "Member" })).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it("runs a row's action and closes", async () => {
    const onRename = vi.fn();
    render(<Harness onRename={onRename} onRemove={() => {}} />);
    await open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByTestId("member-menu")).toBeNull());
  });

  it("keeps open for a checkbox row and ticks the radio row picked", async () => {
    render(<Harness onRename={() => {}} onRemove={() => {}} />);
    await open();
    const pinned = screen.getByRole("menuitemcheckbox", { name: "Pinned" });
    expect(pinned.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(pinned);
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Pinned" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: "By name" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "By role" }));
    await waitFor(() => expect(screen.queryByTestId("member-menu")).toBeNull());
    await open();
    expect(
      screen.getByRole("menuitemradio", { name: "By role" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
