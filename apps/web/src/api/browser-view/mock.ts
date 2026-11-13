import type { BrowserViewApi } from "./types";

/** The mock server runs no browser of its own: the feed says so, as a real one without it does. */
export const createBrowserViewMock = (): BrowserViewApi => ({
  // eslint-disable-next-line require-yield
  browserViewFeed: async function* () {
    throw Object.assign(new Error("This server runs no browser of its own."), {
      _tag: "InvalidState",
    });
  },
  browserViewInput: async () => {},
  browserViewControl: async () => {},
});
