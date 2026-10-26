/* oxlint-disable unicorn/consistent-function-scoping -- the block below is this script's outer scope */
// Mock kit: the behaviour a mock page needs, with no dependencies and no network beyond reading its
// own mock.json. Copied into each mock's kit/ folder beside kit.css and tokens.css.
//
// A mock page is <body class="mock"> holding a .mock-canvas of <section class="board"> artboards.
// This script adds the bar (title, versions, theme), a name strip per board (size, states, focus),
// state switching (data-states on a board, data-when on what each state shows), the Tweaks panel
// (a <script type="application/json" id="mock-tweaks">), board links (a[data-goto]) and icons
// (<i data-icon="name"></i>). Everything it adds is chrome around the boards, never inside them.
// A block, not a module, so it also runs from file://; its declarations stay out of the page's globals.
{
  /* Icons: Lucide-style paths drawn at 24 × 24, stroked in currentColor. */
  const ICONS = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
    xcircle: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
    okcircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    dashed: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3.2"/>',
    pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12"/>',
    merge:
      '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    branch:
      '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    diff: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M12 10v6M9 13h6"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    inbox:
      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    orch: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8"/>',
    up: '<path d="m5 12 7-7 7 7M12 19V5"/>',
    pause:
      '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    play: '<path d="m7 4 13 8-13 8V4z"/>',
    refresh:
      '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M8 16H3v5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    shield:
      '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    cols: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
    trash:
      '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    reply: '<path d="m9 17-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
    sparkle:
      '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    snooze: '<path d="M4 4h6l-6 7h6M14 12h6l-6 8h6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    archive:
      '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    rail: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 12h3M14 12h3"/>',
    file: '<path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>',
    image:
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    external:
      '<path d="M14 4h6v6M20 4 10 14M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  };
  const svg = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  const hydrateIcons = (root = document) => {
    for (const el of root.querySelectorAll("i[data-icon]")) {
      el.outerHTML = svg(el.getAttribute("data-icon"));
    }
  };

  /* Storage that may be missing (a private window, a file:// page): every read and write guarded. */
  const store = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch {
        /* nothing to keep */
      }
    },
  };

  const html = document.documentElement;
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  };

  /*
   * Theme: auto (the viewer's preference), light or dark, remembered per mock folder. A link may
   * ask for one with `?theme=dark` (Gram's mock card does), which the switch then shows as picked.
   */
  const themeKey = `mock-theme:${location.pathname.replace(/[^/]*$/, "")}`;
  const applyTheme = (mode) => {
    if (mode === "light" || mode === "dark") html.setAttribute("data-theme", mode);
    else html.removeAttribute("data-theme");
  };
  const askedTheme = new URLSearchParams(location.search).get("theme");
  if (askedTheme === "light" || askedTheme === "dark") store.set(themeKey, askedTheme);
  const savedTheme = () =>
    askedTheme === "light" || askedTheme === "dark" ? askedTheme : store.get(themeKey);
  applyTheme(savedTheme());

  /* Boards: a name strip with size, states and focus. */
  const slug = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const boards = () => [...document.querySelectorAll(".board")];
  const boardByName = (name) =>
    boards().find((b) => b.dataset.name === name || b.id === name || b.id === slug(name));

  const setState = (board, state) => {
    board.dataset.state = state;
    for (const node of board.querySelectorAll("[data-when]")) {
      if (node.closest(".board") !== board) continue;
      const when = node.getAttribute("data-when").split(/[\s,]+/);
      node.hidden = !when.includes(state);
    }
    for (const button of board.querySelectorAll(".board-states button")) {
      button.setAttribute("aria-pressed", String(button.dataset.value === state));
    }
  };

  const focusBoard = (board) => {
    for (const b of boards()) b.removeAttribute("data-focused");
    if (board === undefined) {
      html.removeAttribute("data-mock-focus");
      history.replaceState(null, "", location.pathname + location.search);
      return;
    }
    board.setAttribute("data-focused", "");
    html.setAttribute("data-mock-focus", "");
    history.replaceState(null, "", `#${board.id}`);
    window.scrollTo(0, 0);
  };

  const setupBoard = (board) => {
    const name = board.dataset.name ?? "Board";
    if (!board.id) board.id = slug(name) || `board-${boards().indexOf(board) + 1}`;
    const size = board.dataset.size;
    const frame = board.querySelector(":scope > .board-frame");
    if (size === "fill") board.setAttribute("data-fill", "");
    else if (size && frame) {
      const [w, h] = size.split(/x|×/).map((n) => Number.parseInt(n, 10));
      if (w) frame.style.setProperty("--board-w", `${w}px`);
      if (h) frame.style.setProperty("--board-h", `${h}px`);
    }
    const nameButton = el("button", {
      type: "button",
      class: "board-name",
      text: name,
      title: "Open full window (Esc to return)",
      onclick: () => focusBoard(board.hasAttribute("data-focused") ? undefined : board),
    });
    const label = el(
      "div",
      { class: "board-label" },
      nameButton,
      size && el("span", { class: "board-size", text: size === "fill" ? "page" : size }),
    );
    const states = (board.dataset.states ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (states.length > 1) {
      const group = el("div", {
        class: "board-states",
        role: "group",
        "aria-label": `${name} state`,
      });
      for (const state of states) {
        group.append(
          el("button", {
            type: "button",
            "data-value": state,
            text: state,
            onclick: () => setState(board, state),
          }),
        );
      }
      label.append(group);
    }
    board.prepend(label);
    if (states.length > 0) setState(board, board.dataset.state ?? states[0]);
  };

  const applyTweak = (name, def, value) => {
    if (def.type === "color" || def.type === "range") {
      html.style.setProperty(
        `--tweak-${name}`,
        def.type === "range" ? `${value}${def.unit ?? ""}` : value,
      );
    } else {
      html.setAttribute(`data-tweak-${name}`, String(value));
    }
  };

  /* Tweaks: levers the page declares, applied as data-tweak-* on <html> and --tweak-* properties. */
  const setupTweaks = (bar) => {
    const source = document.getElementById("mock-tweaks");
    if (source === null) return;
    let spec;
    try {
      spec = JSON.parse(source.textContent);
    } catch {
      console.warn("mock kit: #mock-tweaks is not valid JSON");
      return;
    }
    const keyFor = (name) => `mock-tweak:${location.pathname}:${name}`;
    const panel = el("div", {
      class: "mock-tweaks",
      hidden: true,
      role: "dialog",
      "aria-label": "Tweaks",
    });
    panel.append(el("strong", { text: "Tweaks" }));
    for (const [name, def] of Object.entries(spec)) {
      const saved = store.get(keyFor(name));
      let value = saved ?? def.default;
      if (def.type === "boolean") value = String(value) === "true";
      applyTweak(name, def, value);
      const label = def.label ?? name;
      let control;
      if (def.type === "enum") {
        control = el("select", { class: "select" });
        for (const option of def.options ?? []) {
          control.append(el("option", { value: option, text: option, selected: option === value }));
        }
        control.addEventListener("change", () => {
          applyTweak(name, def, control.value);
          store.set(keyFor(name), control.value);
        });
        panel.append(el("label", {}, document.createTextNode(label), control));
      } else if (def.type === "boolean") {
        control = el("input", { type: "checkbox", class: "switch", checked: value === true });
        control.addEventListener("change", () => {
          applyTweak(name, def, control.checked);
          store.set(keyFor(name), String(control.checked));
        });
        panel.append(el("label", { class: "inline" }, document.createTextNode(label), control));
      } else if (def.type === "color") {
        control = el("input", { type: "color", value });
        control.addEventListener("input", () => {
          applyTweak(name, def, control.value);
          store.set(keyFor(name), control.value);
        });
        panel.append(el("label", { class: "inline" }, document.createTextNode(label), control));
      } else if (def.type === "range") {
        control = el("input", {
          type: "range",
          min: def.min ?? 0,
          max: def.max ?? 100,
          step: def.step ?? 1,
          value,
        });
        control.addEventListener("input", () => {
          applyTweak(name, def, control.value);
          store.set(keyFor(name), control.value);
        });
        panel.append(el("label", {}, document.createTextNode(label), control));
      }
    }
    panel.append(
      el("button", {
        type: "button",
        class: "btn sm ghost",
        text: "Reset",
        onclick: () => {
          for (const name of Object.keys(spec)) store.set(keyFor(name), null);
          location.reload();
        },
      }),
    );
    document.body.append(panel);
    bar.append(
      el("button", {
        type: "button",
        class: "btn sm",
        "aria-expanded": "false",
        text: "Tweaks",
        onclick: (event) => {
          panel.hidden = !panel.hidden;
          event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
        },
      }),
    );
  };

  /* The bar: title, version links from mock.json, status, theme. */
  const setupBar = () => {
    const title = document.body.dataset.title ?? document.title.replace(/\s*·\s*v\d+$/, "");
    const bar = el(
      "header",
      { class: "mock-bar" },
      el("span", { class: "mock-title", text: title }),
    );
    const versions = el("nav", { class: "mock-versions", "aria-label": "Versions" });
    const status = el("span", { class: "badge mock-status", hidden: true });
    bar.append(versions, status, el("span", { class: "mock-spacer" }));
    const current = location.pathname.split("/").pop();
    fetch("mock.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((mock) => {
        if (!mock) return;
        for (const v of mock.versions ?? []) {
          const link = el("a", { href: v.file, text: `v${v.n}` });
          if (v.file === current) link.setAttribute("aria-current", "page");
          if (mock.approved === v.n) link.title = "Approved";
          versions.append(link);
        }
        if (mock.status) {
          status.textContent = mock.status.replace("-", " ");
          status.className = `badge mock-status ${mock.status === "approved" ? "success" : ""}`;
          status.hidden = false;
        }
      })
      .catch(() => {
        /* opened as a file: no versions to list */
      });
    const theme = el("div", { class: "segmented", role: "group", "aria-label": "Theme" });
    const saved = savedTheme() ?? "auto";
    for (const mode of ["auto", "light", "dark"]) {
      theme.append(
        el("button", {
          type: "button",
          text: mode,
          "aria-pressed": String(mode === saved),
          onclick: () => {
            applyTheme(mode);
            store.set(themeKey, mode === "auto" ? null : mode);
            for (const b of theme.children)
              b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
          },
          "data-mode": mode,
        }),
      );
    }
    bar.append(theme);
    setupTweaks(bar);
    document.body.prepend(bar);
  };

  const ready = () => {
    hydrateIcons();
    if (document.body.classList.contains("mock")) {
      setupBar();
      for (const board of boards()) setupBoard(board);
      const focusHash = () => {
        const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
        if (target?.classList.contains("board")) focusBoard(target);
      };
      focusHash();
      // A link to another board of the same page (Gram's "Open mock") changes only the hash.
      window.addEventListener("hashchange", focusHash);
    }
    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[data-goto]");
      if (link === null) return;
      event.preventDefault();
      const [name, state] = link.getAttribute("data-goto").split("@");
      const board = boardByName(name);
      if (board === undefined) return;
      if (state) setState(board, state);
      if (html.hasAttribute("data-mock-focus")) focusBoard(board);
      else board.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && html.hasAttribute("data-mock-focus")) focusBoard(undefined);
    });
  };

  window.mockKit = { icon: svg, hydrateIcons, setState, focusBoard, boardByName };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
}
