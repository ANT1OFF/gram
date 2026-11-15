Recorded from `opencode serve` 2.3.0 (`GET /api/event`) against a stand-in OpenAI-compatible
provider that answered with one `shell` call and then text; no real provider, account or key.
Paths are rewritten to `/work/project` and `/home/user`.

- `events-ask.sse`: a session created with `{ action: "shell", resource: "*", effect: "ask" }`,
  the permission answered `once` through the API.
- `events-tool.sse`: two turns on default permissions, which run the command unasked.
