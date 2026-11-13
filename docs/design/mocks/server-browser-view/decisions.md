# Watching and driving the server's browser: decisions

One line per review round: what was asked, what changed, in which version. The mock-review skill
keeps this; the build reads it with the approved version.
v2: taking control is by any click or key in the page, as in the desktop app, and it returns to the agent after a short idle (20 s) or with Hand back; the Take control buttons and the tweak are gone. The empty state no longer offers typing an address: the first build shows only the page the agent opened (asked 13 November, 23:14).
Build: the strip keeps Forward beside Back, as the pane has it; Inspect and Open in your browser are left out (inspection needs the shell, and the page's address is the server's loopback, which your browser can't open); the failed state has no Try again, since only the agent's next command opens a page; the hint over the agent's page wraps in a narrow panel.
