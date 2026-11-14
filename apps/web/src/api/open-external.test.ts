// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";

import { openExternalUrl } from "./open-external";
import type { Api } from "./types";

const api = () =>
  ({ openExternal: vi.fn(async () => undefined) }) as unknown as Api & {
    openExternal: ReturnType<typeof vi.fn>;
  };

afterEach(() => {
  useEmbedShell.setState(EMPTY_SHELL);
  vi.restoreAllMocks();
});

describe("openExternalUrl", () => {
  it("asks the server's opener when the server is the person's own", async () => {
    const server = api();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openExternalUrl(server, "https://github.com/acme/app/pull/1");
    expect(server.openExternal).toHaveBeenCalledWith("https://github.com/acme/app/pull/1");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a new tab when the server is hosted, where its opener shows the person nothing", async () => {
    useEmbedShell.setState({ hosted: true });
    const server = api();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openExternalUrl(server, "https://github.com/acme/app/pull/1");
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/app/pull/1",
      "_blank",
      "noopener,noreferrer",
    );
    expect(server.openExternal).not.toHaveBeenCalled();
  });

  it("opens only http(s) links in a tab", async () => {
    useEmbedShell.setState({ hosted: true });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openExternalUrl(api(), "javascript:alert(1)");
    expect(open).not.toHaveBeenCalled();
  });
});
