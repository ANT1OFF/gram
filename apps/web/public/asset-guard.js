// Loaded before the app as a classic script, since the CSP allows no inline one. The app's scripts
// and styles come from the server, and one that fails to load leaves the page blank for good: the
// entry module never runs. That happened when the app's server restarted while it
// served the page (it crashed on EMFILE mid-load, came back in two seconds, and the window stayed
// dark). So reload, at most once a minute, and if it keeps failing say so instead of a dark page.
"use strict";
// A block, not a function, so its constants stay out of the page's globals.
{
  const KEY = "gram.assetReloadAt";
  const WAIT_MS = 60_000;
  const PROBE_MS = 1_000;
  const PROBE_TIMEOUT_MS = 5_000;
  const RECOVERY_MS = 30_000;
  const ROOT = "root";
  let probing = false;

  // A mounted app copes with its own lazy chunk failing (the terminal view does), and a reload
  // would throw away what it holds only in memory: composer drafts, unsent diff comments.
  const mounted = () => {
    const root = document.getElementById(ROOT);
    return root !== null && root.hasChildNodes();
  };

  const explain = () => {
    const root = document.getElementById(ROOT);
    if (root === null || root.hasChildNodes()) return;
    root.textContent =
      "Gram couldn't load all of its files. Reload the window (Ctrl+R, or ⌘R on a Mac) to try again.";
    root.setAttribute("role", "alert");
    root.style.cssText = "padding:2rem;font:14px system-ui,sans-serif;color:#c0caf5";
  };

  const reloadedRecently = () => {
    try {
      return Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) <= WAIT_MS;
    } catch {
      // Storage refused (a sandboxed frame): reloading every time would loop, so only explain.
      return true;
    }
  };

  // Only a reload that is remembered may happen: storage that reads but refuses writes (a full
  // quota) would otherwise let every reloaded page reload again.
  const remember = () => {
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
      return true;
    } catch {
      return false;
    }
  };

  const failed = () => {
    if (mounted() || probing) return;
    if (reloadedRecently()) {
      explain();
      return;
    }
    // Reloading while the server restarts would swap this page for an error page, which has no
    // guard to recover it. So wait until the page answers again, for half a minute at most: each
    // probe is cut off too, since a server that accepts but never answers would otherwise hold
    // `probing` for good.
    probing = true;
    const deadline = Date.now() + RECOVERY_MS;
    const probe = () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      fetch(location.href, { cache: "no-store", signal: controller.signal })
        .then(
          (response) => response.ok,
          () => false,
        )
        .then((up) => {
          clearTimeout(timer);
          if (mounted()) return;
          if (up) {
            if (remember()) location.reload();
            else explain();
          } else if (Date.now() + PROBE_MS < deadline) {
            setTimeout(probe, PROBE_MS);
          } else {
            explain();
          }
        });
    };
    probe();
  };

  // An element's failed load doesn't bubble, so it is caught on the way down.
  window.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target === null || target === window) return;
      const tag = target.tagName;
      if (tag !== "SCRIPT" && tag !== "LINK") return;
      const url = target.src || target.href || "";
      if (!url.includes("/assets/")) return;
      failed();
    },
    true,
  );

  // Vite's own signal for a lazily loaded chunk that failed. Before the app mounts it is handled
  // here; after, it is left to throw to the code that imported the chunk.
  window.addEventListener("vite:preloadError", (event) => {
    if (mounted()) return;
    event.preventDefault();
    failed();
  });
}
