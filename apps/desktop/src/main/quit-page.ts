/** The title Quit Now gives the page; the page has no other way to reach main. */
export const QUIT_NOW_TITLE = "quit-now";

/** The progress window's page, in the theme's colours; its Quit Now button sets the title. */
export function quitPage(colors: { readonly background: string; readonly foreground: string }) {
  const { background: bg, foreground: fg } = colors;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Quitting Gram</title>
<style>
html,body{margin:0;height:100%;background:${bg};color:${fg};
  font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  -webkit-user-select:none;user-select:none;cursor:default}
body{box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:6px;
  padding:16px 20px;border:1px solid color-mix(in srgb,${fg} 14%,transparent);-webkit-app-region:drag}
h1{display:flex;align-items:center;gap:9px;margin:0;font-size:13px;font-weight:600}
.spin{width:12px;height:12px;border-radius:50%;border:2px solid color-mix(in srgb,${fg} 22%,transparent);
  border-top-color:${fg};animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
p{margin:0 0 0 23px;opacity:.72}
.row{display:flex;justify-content:flex-end;margin-top:8px}
button{-webkit-app-region:no-drag;font:inherit;color:inherit;padding:4px 14px;border-radius:6px;
  border:1px solid color-mix(in srgb,${fg} 24%,transparent);background:color-mix(in srgb,${fg} 8%,transparent)}
button:hover{background:color-mix(in srgb,${fg} 14%,transparent)}
</style></head>
<body><h1><span class="spin"></span>Quitting Gram…</h1>
<p id="detail">Saving your threads…</p>
<div class="row"><button id="now" title="Stop everything now, without waiting">Quit Now</button></div>
<script>
const QUIT_NOW = ${JSON.stringify(QUIT_NOW_TITLE)};
document.getElementById("now").addEventListener("click", () => { document.title = QUIT_NOW; });
window.setDetail = (text) => { document.getElementById("detail").textContent = text; };
</script></body></html>`;
}
