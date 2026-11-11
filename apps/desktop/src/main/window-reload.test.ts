import { describe, expect, it } from "vitest";

import { reloadOnto, type ReloadableWindow } from "./window-reload.ts";

/** A synthetic window recording what it was navigated to. */
const window = (name: string, destroyed = false) => {
  const loads: string[] = [];
  const win: ReloadableWindow & { readonly name: string; readonly loads: string[] } = {
    name,
    loads,
    webContents: { isDestroyed: () => destroyed },
    loadURL: async (url) => {
      loads.push(url);
    },
  };
  return win;
};

describe("reloading windows onto a fresh server", () => {
  it("keeps an update's progress window on its own page through recovery", () => {
    // The order a refused stop's recovery runs in: the update's progress window is open beside
    // the hidden app window when `restartServer` reloads every window onto the new server.
    const app = window("app");
    const progress = window("progress");
    reloadOnto("http://127.0.0.1:58170/?boot=x", [app, progress], (win) => win === progress);
    expect(app.loads).toEqual(["http://127.0.0.1:58170/?boot=x"]);
    // Still the data: page whose setDetail shows the retry, not the app.
    expect(progress.loads).toEqual([]);
  });

  it("skips a destroyed window", () => {
    const gone = window("gone", true);
    reloadOnto("http://127.0.0.1:1/", [gone], () => false);
    expect(gone.loads).toEqual([]);
  });
});
