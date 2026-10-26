import { fireEvent, screen, within } from "@testing-library/react";

/** Opens a Settings list row's ⋯ and picks `item` from it. */
export async function chooseFromRowMenu(row: HTMLElement, item: string): Promise<void> {
  fireEvent.click(within(row).getByRole("button", { name: / actions$/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}
