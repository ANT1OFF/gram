// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Page } from "./page";

afterEach(cleanup);

describe("Page", () => {
  it("is titled by an h1 shown everywhere, with nothing above it, by default", () => {
    render(<Page title="Members">Rows</Page>);
    const title = screen.getByRole("heading", { level: 1, name: "Members" });
    expect(title.className).not.toContain("sr-only");
    expect(document.querySelector('[data-slot="page-above"]')).toBeNull();
  });

  it("puts a context line or tabs over the title", () => {
    render(
      <Page title="Ada Lovelace" above={<a href="/members">Members</a>}>
        Rows
      </Page>,
    );
    const above = document.querySelector('[data-slot="page-above"]')!;
    expect(above.textContent).toBe("Members");
    const title = screen.getByRole("heading", { name: "Ada Lovelace" });
    expect(above.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("takes an h2 under the app's own h1, looking the same", () => {
    render(
      <Page title="Limits" headingLevel={2}>
        Rows
      </Page>,
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Limits" }).className).toContain(
      "text-heading",
    );
  });

  it("leaves the title to a phone's own bar, still a heading for a screen reader", () => {
    render(
      <Page title="Limits" hideTitleOnPhone>
        Rows
      </Page>,
    );
    expect(screen.getByRole("heading", { name: "Limits" }).className).toContain("phone:sr-only");
  });

  it("keeps Settings' reading column unless it is wide", () => {
    render(<Page title="Narrow">Rows</Page>);
    expect(document.querySelector('[data-slot="page"]')!.className).toContain("settings-column");
    cleanup();
    render(
      <Page title="Wide" wide>
        Rows
      </Page>,
    );
    const page = document.querySelector('[data-slot="page"]')!;
    expect(page.className).not.toContain("settings-column");
    expect(page.className).toContain("w-full");
  });
});
