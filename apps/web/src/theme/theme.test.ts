import { readFileSync } from "node:fs";

import { paletteFromSeeds, PRESET_PALETTES } from "@gram/themes";
import { describe, expect, it, vi } from "vitest";

import { createThemeStore, THEME_STORAGE_KEY } from "./store";
import { startThemeSync } from "./sync";
import type { SystemSource } from "./system";
import {
  DEFAULT_SYSTEM_PREFS,
  DEFAULT_THEME,
  resolveContrast,
  resolveMode,
  resolveMotion,
  sanitizePrefs,
  themeAttributes,
  type SystemPrefs,
} from "./theme";
import { revealKeyframes, switchTheme, THEME_SWITCHING_ATTR } from "./transition";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
    animate: vi.fn(),
  };
}

function controllableSystem(initial: SystemPrefs = DEFAULT_SYSTEM_PREFS) {
  let prefs = initial;
  const listeners = new Set<() => void>();
  const source: SystemSource = {
    get: () => prefs,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    source,
    set(patch: Partial<SystemPrefs>) {
      prefs = { ...prefs, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

describe("resolvers", () => {
  it("follows the OS only for system", () => {
    expect(resolveMotion("system", true)).toBe("reduced");
    expect(resolveMotion("system", false)).toBe("full");
    expect(resolveMotion("off", false)).toBe("off");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
    expect(resolveContrast("system", true)).toBe("more");
    expect(resolveContrast("system", false)).toBe("standard");
    expect(resolveContrast("more", false)).toBe("more");
  });
});

describe("themeAttributes", () => {
  it("resolves every axis onto html attributes", () => {
    expect(themeAttributes(DEFAULT_THEME, DEFAULT_SYSTEM_PREFS)).toEqual({
      "data-look": "glass",
      "data-palette": "neutral-dark",
      "data-mode": "dark",
      "data-density": "comfortable",
      "data-contrast": "standard",
      "data-motion": "full",
    });
  });

  it("switches to the paired palette for the requested mode", () => {
    const attrs = themeAttributes(
      { ...DEFAULT_THEME, mode: "system" },
      { ...DEFAULT_SYSTEM_PREFS, prefersDark: false },
    );
    expect(attrs["data-palette"]).toBe("neutral");
    expect(attrs["data-mode"]).toBe("light");
  });

  it("keeps single-mode palettes in their own mode", () => {
    const attrs = themeAttributes(
      { ...DEFAULT_THEME, palette: "dracula", mode: "light" },
      DEFAULT_SYSTEM_PREFS,
    );
    expect(attrs["data-palette"]).toBe("dracula");
    expect(attrs["data-mode"]).toBe("dark");
  });

  it("renders the chosen density", () => {
    expect(
      themeAttributes({ ...DEFAULT_THEME, density: "compact" }, DEFAULT_SYSTEM_PREFS)[
        "data-density"
      ],
    ).toBe("compact");
  });

  it("falls back to the default palette for unknown ids", () => {
    expect(
      themeAttributes({ ...DEFAULT_THEME, palette: "gone" }, DEFAULT_SYSTEM_PREFS)["data-palette"],
    ).toBe("neutral-dark");
  });
});

describe("index.html boot script", () => {
  const bootHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const bootSource = /<script>([\s\S]*?)<\/script>/.exec(bootHtml)![1]!;
  function boot(saved: string | null, prefersLight = true) {
    const dataset = Object.fromEntries(
      [...bootHtml.matchAll(/data-(look|palette|mode|motion)="([^"]*)"/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    const storage = { getItem: vi.fn(() => saved), setItem: vi.fn() };
    new Function("localStorage", "document", "matchMedia", bootSource)(
      storage,
      { documentElement: { dataset } },
      () => ({ matches: prefersLight }),
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    return dataset;
  }

  it.each([null, "{}", '{"state":{}}', '{"state":{"motion":"off"}}', "broken"])(
    "first-paints fresh or unset storage as Glass Neutral Dark on a light OS (%s)",
    (saved) => {
      expect(boot(saved)).toMatchObject({ look: "glass", palette: "neutral-dark", mode: "dark" });
    },
  );

  it.each(["light", "system"])("pairs the unset palette for explicit %s on a light OS", (mode) => {
    expect(boot(JSON.stringify({ state: { mode } }))).toMatchObject({
      palette: "neutral",
      mode: "light",
    });
  });

  it("follows the OS only for an explicit saved system mode", () => {
    const saved = JSON.stringify({ state: { look: "glass", palette: "forest", mode: "system" } });
    expect(boot(saved, true)).toMatchObject({ look: "glass", palette: "forest", mode: "light" });
    expect(boot(saved, false)).toMatchObject({ look: "glass", palette: "forest", mode: "dark" });
  });
});

/** Lets the asset guard's probe of the page settle: its fetch and the steps chained on it. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("index.html asset guard", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../../public/asset-guard.js", import.meta.url), "utf8");

  /**
   * Runs the guard against a fake page, the way index.html loads it before the app. `answers`
   * are the page probe's statuses in turn, then 200; `"hang"` never answers until aborted.
   * `wait(ms)` moves the clock on and fires the timer pending with that delay.
   */
  function page({
    storage = new Map<string, string>(),
    clock = { now: 1_000_000 },
    answers = [] as (number | "down" | "hang")[],
    refuseWrites = false,
  } = {}) {
    const listeners = new Map<string, (event: unknown) => void>();
    const root = {
      children: 0,
      textContent: "",
      role: undefined as string | undefined,
      style: { cssText: "" },
      hasChildNodes() {
        return this.children > 0;
      },
      setAttribute(_name: string, value: string) {
        this.role = value;
      },
    };
    const reloads: number[] = [];
    const timers = new Map<number, { readonly ms: number; readonly callback: () => void }>();
    let nextTimer = 0;
    const probes: string[] = [];
    const window = {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
    };
    const fetch = (url: string, init: { readonly signal: AbortSignal }) => {
      probes.push(url);
      const answer = answers.shift() ?? 200;
      if (answer === "hang") {
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(new DOMException("", "AbortError"))),
        );
      }
      return answer === "down"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve({ ok: answer < 300 });
    };
    const wait = (ms: number) => {
      const [id, timer] = [...timers].find(([, pending]) => pending.ms === ms)!;
      timers.delete(id);
      clock.now += ms;
      timer.callback();
    };
    new Function(
      "window",
      "document",
      "sessionStorage",
      "location",
      "Date",
      "fetch",
      "setTimeout",
      "clearTimeout",
      source,
    )(
      window,
      { getElementById: () => root },
      {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (refuseWrites) throw new DOMException("full", "QuotaExceededError");
          storage.set(key, value);
        },
      },
      { href: "https://vm.example/", reload: () => reloads.push(clock.now) },
      { now: () => clock.now },
      fetch,
      (callback: () => void, ms: number) => {
        timers.set(++nextTimer, { ms, callback });
        return nextTimer;
      },
      (id: number) => timers.delete(id),
    );
    const failLoad = (tagName: string, url: string) =>
      listeners.get("error")!({
        target: tagName === "SCRIPT" ? { tagName, src: url } : { tagName, href: url },
      });
    return { listeners, root, reloads, clock, failLoad, timers, wait, probes, storage };
  }

  it("loads before the app, as a script of its own, since the CSP allows no inline one", () => {
    const guard = html.indexOf('<script src="/asset-guard.js"></script>');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(html.indexOf('type="module"'));
  });

  it("reloads once when one of the app's own files fails, then explains instead of looping", async () => {
    const first = page();
    first.failLoad("SCRIPT", "https://vm.example/assets/gauge-DSEF74Z4.js");
    await settle();
    expect(first.probes).toEqual(["https://vm.example/"]);
    expect(first.reloads).toEqual([1_000_000]);
    // The reloaded page fails again within the minute: no second reload, a message instead.
    const { storage, clock } = first;
    clock.now += 5_000;
    const second = page({ storage, clock });
    second.failLoad("LINK", "https://vm.example/assets/index.css");
    await settle();
    expect(second.probes).toEqual([]);
    expect(second.reloads).toEqual([]);
    expect(second.root.textContent).toMatch(/couldn't load all of its files/);
    expect(second.root.role).toBe("alert");
    // A minute on, it tries again.
    clock.now += 60_001;
    const third = page({ storage, clock });
    third.failLoad("SCRIPT", "https://vm.example/assets/index.js");
    await settle();
    expect(third.reloads).toHaveLength(1);
  });

  it("waits for a restarting server to answer before reloading, and explains if it never does", async () => {
    const restarting = page({ answers: [502, "down"] });
    restarting.failLoad("SCRIPT", "https://vm.example/assets/gauge.js");
    restarting.failLoad("SCRIPT", "https://vm.example/assets/index.js");
    await settle();
    // One probe for both failures, and no reload onto the relay's 502.
    expect(restarting.probes).toHaveLength(1);
    expect(restarting.reloads).toEqual([]);
    restarting.wait(1_000);
    await settle();
    expect(restarting.reloads).toEqual([]);
    restarting.wait(1_000);
    await settle();
    expect(restarting.reloads).toHaveLength(1);

    const gone = page({ answers: Array.from({ length: 100 }, () => 502 as const) });
    const start = gone.clock.now;
    gone.failLoad("SCRIPT", "https://vm.example/assets/gauge.js");
    await settle();
    while ([...gone.timers.values()].some(({ ms }) => ms === 1_000)) {
      gone.wait(1_000);
      await settle();
    }
    expect(gone.clock.now - start).toBeLessThanOrEqual(30_000);
    expect(gone.timers.size).toBe(0);
    expect(gone.reloads).toEqual([]);
    expect(gone.root.textContent).toMatch(/couldn't load all of its files/);
    // Unspent, so a reload later in the session still gets its try.
    expect(gone.storage.size).toBe(0);
  });

  it("cuts off a probe the server never answers, and gives up within the deadline", async () => {
    const stalled = page({ answers: ["hang"] });
    stalled.failLoad("SCRIPT", "https://vm.example/assets/gauge.js");
    await settle();
    expect(stalled.reloads).toEqual([]);
    stalled.wait(5_000);
    await settle();
    stalled.wait(1_000);
    await settle();
    expect(stalled.probes).toHaveLength(2);
    expect(stalled.reloads).toHaveLength(1);

    const silent = page({ answers: Array.from({ length: 100 }, () => "hang" as const) });
    const start = silent.clock.now;
    silent.failLoad("SCRIPT", "https://vm.example/assets/gauge.js");
    for (;;) {
      await settle();
      const next = [...silent.timers.values()][0];
      if (next === undefined) break;
      silent.wait(next.ms);
    }
    expect(silent.clock.now - start).toBeLessThanOrEqual(30_000 + 5_000);
    expect(silent.reloads).toEqual([]);
    expect(silent.root.textContent).toMatch(/couldn't load all of its files/);
  });

  it("explains rather than reloads when storage won't remember the reload", async () => {
    const { reloads, root, failLoad } = page({ refuseWrites: true });
    failLoad("SCRIPT", "https://vm.example/assets/gauge.js");
    await settle();
    expect(reloads).toEqual([]);
    expect(root.textContent).toMatch(/couldn't load all of its files/);
  });

  it("leaves other failures alone, and a mounted app's page as it is", async () => {
    const { reloads, failLoad, listeners, probes } = page();
    failLoad("IMG", "https://vm.example/assets/logo.png");
    failLoad("SCRIPT", "https://organization.example.invalid/widget.js");
    listeners.get("error")!({ target: null });
    await settle();
    expect(probes).toEqual([]);
    expect(reloads).toEqual([]);
    // Nothing reloaded yet this session: a mounted app still isn't reloaded, nor its error taken.
    const mounted = page();
    mounted.root.children = 1;
    mounted.failLoad("SCRIPT", "https://vm.example/assets/lazy.js");
    const preventDefault = vi.fn();
    mounted.listeners.get("vite:preloadError")!({ preventDefault });
    await settle();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(mounted.probes).toEqual([]);
    expect(mounted.reloads).toEqual([]);
    expect(mounted.storage.size).toBe(0);
    expect(mounted.root.textContent).toBe("");
  });

  it("takes Vite's failed lazy chunk before the app mounts, instead of letting it throw", async () => {
    const { listeners, reloads } = page();
    const preventDefault = vi.fn();
    listeners.get("vite:preloadError")!({ preventDefault });
    await settle();
    expect(preventDefault).toHaveBeenCalled();
    expect(reloads).toHaveLength(1);
  });
});

describe("sanitizePrefs", () => {
  it("drops unknown values", () => {
    expect(
      sanitizePrefs({ palette: "dracula", motion: "off", mode: 3, density: "huge", extra: 1 }),
    ).toEqual({
      palette: "dracula",
      motion: "off",
    });
    expect(sanitizePrefs(null)).toEqual({});
  });

  it("keeps Glass and reads the server's standard contrast as system", () => {
    expect(sanitizePrefs({ look: "glass", contrast: "standard" })).toEqual({
      look: "glass",
      contrast: "system",
    });
    expect(sanitizePrefs({ look: "other", density: "auto", motion: "full" })).toEqual({});
  });
});

describe("store ↔ attribute sync", () => {
  it.each([undefined, {}, { motion: "off" }])(
    "fresh or unset appearance stays Glass Neutral Dark on a light OS (%j)",
    (saved) => {
      const storage = memoryStorage();
      if (saved) storage.setItem(THEME_STORAGE_KEY, JSON.stringify({ state: saved, version: 1 }));
      const before = storage.getItem(THEME_STORAGE_KEY);
      const store = createThemeStore(storage);
      const system = controllableSystem({ ...DEFAULT_SYSTEM_PREFS, prefersDark: false });
      const root = fakeRoot();
      const dispose = startThemeSync(store, system.source, root);
      expect(store.getState()).toMatchObject({
        look: "glass",
        palette: "neutral-dark",
        mode: "dark",
      });
      expect(root.attrs.get("data-palette")).toBe("neutral-dark");
      expect(root.attrs.get("data-mode")).toBe("dark");
      system.set({ prefersDark: true });
      system.set({ prefersDark: false });
      expect(root.attrs.get("data-palette")).toBe("neutral-dark");
      expect(storage.getItem(THEME_STORAGE_KEY)).toBe(before);
      dispose();
    },
  );

  it.each(["system", "light", "dark"] as const)(
    "hydrates an explicit Tokyo Night %s choice without rewriting storage",
    (mode) => {
      const storage = memoryStorage();
      const saved = JSON.stringify({
        state: { look: "glass", palette: "tokyo-night", mode },
        version: 1,
      });
      storage.setItem(THEME_STORAGE_KEY, saved);
      const store = createThemeStore(storage);
      const root = fakeRoot();
      const system = controllableSystem({ ...DEFAULT_SYSTEM_PREFS, prefersDark: false });
      const dispose = startThemeSync(store, system.source, root);
      expect(store.getState()).toMatchObject({ look: "glass", palette: "tokyo-night", mode });
      expect(root.attrs.get("data-palette")).toBe(mode === "dark" ? "tokyo-night" : "tokyo-light");
      system.set({ prefersDark: true });
      expect(root.attrs.get("data-palette")).toBe(mode === "light" ? "tokyo-light" : "tokyo-night");
      expect(storage.getItem(THEME_STORAGE_KEY)).toBe(saved);
      dispose();
    },
  );

  it("applies the store and OS preferences to the root until disposed", () => {
    const store = createThemeStore(memoryStorage());
    const system = controllableSystem();
    const root = fakeRoot();
    const dispose = startThemeSync(store, system.source, root);

    expect(root.attrs.get("data-palette")).toBe("neutral-dark");

    store.getState().setTheme({ density: "compact", motion: "system", mode: "system" });
    expect(root.attrs.get("data-density")).toBe("compact");

    system.set({ prefersReducedMotion: true, prefersDark: false });
    expect(root.attrs.get("data-motion")).toBe("reduced");
    expect(root.attrs.get("data-palette")).toBe("neutral");

    dispose();
    store.getState().setTheme({ density: "comfortable" });
    expect(root.attrs.get("data-density")).toBe("compact");
  });

  it("renders custom palettes by id", () => {
    const store = createThemeStore(memoryStorage());
    const root = fakeRoot();
    startThemeSync(store, controllableSystem().source, root);
    const custom = paletteFromSeeds(PRESET_PALETTES[3].seeds, { id: "custom:mine", name: "Mine" });
    store.getState().setCustomPalettes([custom]);
    store.getState().setTheme({ palette: "custom:mine" });
    expect(root.attrs.get("data-palette")).toBe("custom:mine");
  });

  it("persists preferences and sanitises them on hydrate", () => {
    const storage = memoryStorage();
    createThemeStore(storage).getState().setTheme({ density: "compact", motion: "off" });
    expect(JSON.parse(storage.map.get(THEME_STORAGE_KEY)!).state).toMatchObject({
      look: "glass",
      density: "compact",
      motion: "off",
    });

    storage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        state: { look: "unknown", density: "huge", customPalettes: [{ id: "x" }] },
        version: 1,
      }),
    );
    const state = createThemeStore(storage).getState();
    expect(state.look).toBe("glass");
    expect(state.density).toBe("comfortable");
    expect(state.customPalettes).toEqual([]);
  });
});

function fakeDoc() {
  const root = fakeRoot();
  const startViewTransition = vi.fn((update: () => void) => {
    update();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  const doc = {
    documentElement: root,
    defaultView: { innerWidth: 300, innerHeight: 400 },
    startViewTransition,
  } as unknown as Document;
  return { doc, root, startViewTransition };
}

describe("theme switch reveal", () => {
  it("grows a circle from the origin to the farthest corner", () => {
    expect(revealKeyframes({ x: 0, y: 0 }, { width: 300, height: 400 })).toEqual({
      clipPath: ["circle(0px at 0px 0px)", "circle(500px at 0px 0px)"],
    });
  });

  it("changes instantly when motion isn't full", () => {
    const store = createThemeStore(memoryStorage());
    store.getState().setTheme({ motion: "reduced" });
    const { doc, startViewTransition } = fakeDoc();
    switchTheme(
      { palette: "dracula" },
      { x: 10, y: 10 },
      { store, doc, system: controllableSystem().source },
    );
    expect(store.getState().palette).toBe("dracula");
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("reveals through a view transition when motion is full", async () => {
    const store = createThemeStore(memoryStorage());
    store.getState().setTheme({ motion: "system" });
    const { doc, root, startViewTransition } = fakeDoc();
    switchTheme(
      { palette: "dracula" },
      { x: 10, y: 20 },
      { store, doc, system: controllableSystem().source },
    );
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(store.getState().palette).toBe("dracula");
    expect(root.attrs.has(THEME_SWITCHING_ATTR)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(root.animate).toHaveBeenCalledWith(
      revealKeyframes({ x: 10, y: 20 }, { width: 300, height: 400 }),
      expect.objectContaining({ pseudoElement: "::view-transition-new(root)" }),
    );
  });
});
