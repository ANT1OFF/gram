/**
 * The ask window's page: drawn from data the main process hands it, as text and nothing else.
 * It has no bridge. Its answer is its title, `gram-ask:<show>:<answer>:<n>`, which the main
 * process reads from this window's own web contents alone, so no other page can answer for it.
 * Allow takes a pointer click, and only once the content has been on screen for a full second;
 * any new content, or the window going out of sight or losing focus, re-arms that second. The
 * pointer must also have moved since, and pressed on Allow after it, so a steady click on a spot
 * the ask then appears under counts for nothing. The main process checks the second again.
 */

export const ASK_TITLE_PREFIX = "gram-ask:";
/** How long an ask's content is on screen before it can be allowed. */
export const ASK_ARM_MS = 1000;

export interface AskColors {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly warning: string;
}

const script = `
(() => {
  let current = "";
  let shownAt = 0;
  let count = 0;
  let armed = false;
  let moved = false;
  let pressed = false;
  let timer = 0;
  const $ = (id) => document.getElementById(id);
  const answer = (kind) => {
    count += 1;
    document.title = "${ASK_TITLE_PREFIX}" + current + ":" + kind + ":" + count;
  };
  const text = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    return node;
  };
  const drawn = (display, oneLine) => {
    const box = document.createDocumentFragment();
    for (const piece of display.pieces) {
      if (piece.kind === "newline") {
        box.appendChild(text("span", "nl", "\\u21b5"));
        if (!oneLine) box.appendChild(document.createElement("br"));
      } else box.appendChild(text("span", piece.kind === "escape" ? "esc" : "", piece.text));
    }
    return box;
  };
  const disarm = () => {
    armed = false;
    moved = false;
    pressed = false;
    clearTimeout(timer);
    $("allow").disabled = true;
  };
  const arm = () => {
    disarm();
    shownAt = performance.now();
    timer = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      armed = true;
      $("allow").disabled = false;
    }, ${ASK_ARM_MS});
  };
  window.showAsk = (id, view) => {
    current = id;
    document.body.dataset.state = "asking";
    $("heading").textContent = view.heading;
    $("server").textContent = view.server;
    $("folder").textContent = view.folderPath;
    $("grant").textContent = view.grantLine;
    const warnings = $("warnings");
    warnings.replaceChildren(...view.warnings.map((line) => text("li", "", line)));
    const says = $("says");
    says.replaceChildren();
    for (const item of view.says) {
      const row = text("div", "row", "");
      row.appendChild(text("span", "label", item.label));
      const value = text("span", "value", "");
      value.appendChild(drawn(item.display, true));
      row.appendChild(value);
      says.appendChild(row);
    }
    $("target-label").textContent = view.targetLabel;
    const target = $("target");
    target.replaceChildren(drawn(view.target));
    $("size").textContent = view.size ?? "";
    $("facts").replaceChildren(...view.facts.map((line) => text("li", "", line)));
    $("allow").textContent = view.allowLabel;
    $("refuse").textContent = view.refuseLabel;
    $("status").textContent = "";
    $("refuse").hidden = false;
    $("allow").hidden = false;
    $("dismiss").hidden = true;
    arm();
  };
  window.withdrawAsk = (id, why) => {
    if (id !== current) return;
    disarm();
    document.body.dataset.state = "withdrawn";
    $("status").textContent = why;
    $("allow").hidden = true;
    $("refuse").hidden = true;
    $("dismiss").hidden = false;
  };
  document.addEventListener("visibilitychange", () => {
    // Out of sight and back is new content to the person: the second starts again.
    if (document.body.dataset.state === "asking") arm();
  });
  window.addEventListener("blur", () => {
    // Their attention went elsewhere: when it comes back, so does the second.
    if (document.body.dataset.state === "asking") arm();
  });
  document.addEventListener("pointermove", (event) => {
    if (event.isTrusted && armed) moved = true;
  });
  $("allow").addEventListener("pointerdown", (event) => {
    pressed = event.isTrusted && armed && moved;
  });
  $("allow").addEventListener("click", (event) => {
    // A pointer click only: a key pressed on a focused button clicks with no detail.
    if (!event.isTrusted || event.detail < 1 || !armed || !moved || !pressed) return;
    if (performance.now() - shownAt < ${ASK_ARM_MS}) return;
    disarm();
    answer("allow");
  });
  $("allow").addEventListener("keydown", (event) => event.preventDefault());
  $("refuse").addEventListener("click", () => {
    disarm();
    answer("refuse");
  });
  $("dismiss").addEventListener("click", () => answer("dismiss"));
})();
`;

/** The page, whole, as a `data:` address loads it: its own opaque origin, nothing fetched. */
export const askPage = (colors: AskColors): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Gram is asking</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: ${colors.background}; color: ${colors.foreground}; user-select: none;
  }
  h1 { font-size: 15px; margin: 0 0 8px; }
  .row { display: flex; gap: 8px; margin: 2px 0; }
  .label { color: ${colors.muted}; min-width: 84px; flex: none; }
  .value { overflow-wrap: anywhere; }
  .says {
    border-left: 2px solid ${colors.border}; padding-left: 8px; margin: 8px 0;
    max-height: 120px; overflow: auto;
  }
  .says-title, .facts-title, .target-label { color: ${colors.muted}; font-size: 12px; margin: 10px 0 4px; }
  #warnings { color: ${colors.warning}; margin: 0 0 8px; padding-left: 18px; }
  #warnings:empty { display: none; }
  .command {
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
    border: 1px solid ${colors.border}; border-radius: 6px; padding: 8px;
    max-height: 180px; overflow: auto;
  }
  .esc { border: 1px solid ${colors.warning}; color: ${colors.warning}; border-radius: 3px; padding: 0 2px; }
  .nl { color: ${colors.muted}; }
  #facts { margin: 0; padding-left: 18px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  button {
    font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid ${colors.border};
    background: transparent; color: inherit; cursor: pointer;
  }
  #allow { background: ${colors.accent}; color: ${colors.background}; border-color: ${colors.accent}; }
  #allow:disabled { opacity: 0.45; cursor: default; }
  #status { color: ${colors.warning}; font-weight: 600; }
  body[data-state="withdrawn"] .command, body[data-state="withdrawn"] .says { opacity: 0.5; }
</style>
</head>
<body data-state="idle">
<h1 id="heading"></h1>
<ul id="warnings"></ul>
<div class="row"><span class="label">Server</span><span class="value" id="server"></span></div>
<div class="row"><span class="label">Folder</span><span class="value" id="folder"></span></div>
<div class="row"><span class="label"></span><span class="value" id="grant"></span></div>
<div class="says-title">The server says</div>
<div class="says" id="says"></div>
<div class="target-label" id="target-label"></div>
<div class="command" id="target"></div>
<div class="row"><span class="value" id="size"></span></div>
<div class="facts-title">What it runs</div>
<ul id="facts"></ul>
<div class="actions">
  <span id="status"></span>
  <button id="refuse" type="button">Don't run</button>
  <button id="allow" type="button" tabindex="-1" disabled></button>
  <button id="dismiss" type="button" hidden>Dismiss</button>
</div>
<script>${script}</script>
</body>
</html>`;

export type AskPageAnswer = "allow" | "refuse" | "dismiss";

/** Reads an answer from the page's title: which show it answers, and what. */
export const askAnswerOf = (
  title: string,
): { readonly show: string; readonly answer: AskPageAnswer } | undefined => {
  const match = /^gram-ask:([A-Za-z0-9_-]{8,64}):(allow|refuse|dismiss):[0-9]+$/.exec(title);
  if (match === null) return undefined;
  return { show: match[1] ?? "", answer: match[2] as AskPageAnswer };
};
