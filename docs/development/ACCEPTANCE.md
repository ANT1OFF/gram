# Desktop and provider acceptance

[Up: development](../DEVELOPMENT.md) · [Testing guide](../VERIFICATION.md)

These checks require explicit authorization when they use accounts, provider turns,
model downloads, microphone access or app installation. Ordinary development and CI
use synthetic agents. A model listing is not proof of entitlement.

The default Vitest suite includes `packages/agents/src/subscription-protocol.test.ts`.
It starts synthetic child CLIs through `ClaudeHostLive` (the installed Agent SDK,
binary discovery, auth check, hooks and stream-json) and `CodexHostLive` (app-server,
JSON-RPC, shared-server routing and lifecycle). The fixtures under
`packages/agents/fixtures/subscriptions/` are invented executable protocols, with
synthetic session stores, a probe environment and Git repositories/worktrees. They
never use account credentials, contact providers or substitute Gram's echo agent.
Their resume/fork, model switches, approvals/rejections, cancellation, reconnect,
startup/sign-out recovery and notification-order assertions establish adapter behavior;
they do not establish subscription access. The child fixtures run on Linux/macOS;
Windows native executable/shim behavior still needs desktop acceptance.

```sh
bun run test packages/agents/src/subscription-protocol.test.ts
```

Real subscription checks are a separate, explicit opt-in. Each selected adapter
makes two tiny turns, using the desktop's existing CLI login, in a temporary Git
repository. It checks discovery, streaming and resume. It denies any approval
request; the prompt asks for no tools. Standard checks use the CLI's configured
connectors; `GRAM_LIVE_CONFINED=1` additionally requires every external MCP server
to be disabled and fails closed if the CLI leaves one on. Credentials are never
copied into a temporary home. The CLI may retain its own synthetic session history.
An expired login, plan entitlement or upstream failure must be resolved locally;
do not send credentials to chat. Leave this opt-in unset in ordinary CI.

```sh
GRAM_LIVE_SUBSCRIPTIONS=claude,codex bun run test packages/agents/src/subscription.live.test.ts
GRAM_LIVE_SUBSCRIPTIONS=codex GRAM_LIVE_CONFINED=1 bun run test packages/agents/src/subscription.live.test.ts
# Separate authorization: one built-in search turn; inherits explicit CLI search policy.
GRAM_LIVE_CODEX_WEB_SEARCH=1 bun run test packages/agents/src/subscription.live.test.ts
```

`GRAM_LIVE_CLAUDE_BINARY` and `GRAM_LIVE_CODEX_BINARY` optionally select an absolute
installed executable for these probes without changing PATH, dependency pins or
managed runtimes. Record the executable's actual version with acceptance results.
Do not infer Pro/Max or ChatGPT plan tier merely from a successful login or reply.

For manual acceptance of the unsigned macOS build, open
`apps/desktop/release/mac-arm64/Gram.app`. Run `bun run --filter @gram/desktop dist:dir`
and `bun run --filter @gram/desktop verify:package` to rebuild and inspect it.
The directory build is local, unsigned and never published. An isolated desktop
smoke can use `GRAM_FAKE_AGENT=1 GRAM_DATA_DIR=<temporary-folder>` and run the
app's `Contents/MacOS/Gram --smoke`; that validates boot/native loading, not accounts.

For actual packaged GUI acceptance while your ordinary app is running, isolate
both the server data and Electron profile. `GRAM_DATA_DIR` alone does not isolate
the shell's window state, appearance, trusted hosts or gateway vault files:

```sh
acceptanceRoot=$(mktemp -d -t gram-desktop-acceptance)
GRAM_DATA_DIR="$acceptanceRoot/data" GRAM_FAKE_AGENT=0 \
  apps/desktop/release/mac-arm64/Gram.app/Contents/MacOS/Gram \
  --user-data-dir="$acceptanceRoot/electron"
```

Use a disposable Git repository for provider turns. Preserve the original app,
its data and package; quit/restart only the acceptance process. Native automation
may resolve two processes with the same bundle identifier to the ordinary window.
Verify the selected window's Diagnostics data folder before any mutation. A
temporary app copy with a distinct bundle identifier can resolve that ambiguity,
but record the identity change and verify its executable/`app.asar` hashes against
the original. It does not establish the original bundle's signing or microphone
permission identity. Do not copy credential stores into the acceptance profile;
use installed CLIs through their existing logins, and do not publish raw logs.

Complete these checks separately for Claude and Codex in a throwaway repository:

1. Sign in in your own terminal (`claude /login` or `codex login`). Re-check in
   Gram and select the agent with no gateway profile. Verify discovery/defaults,
   then choose a different native model and run a short turn. Visiting Settings
   must not save an unset model default. A stale Claude login must produce an
   authentication failure requiring `/login`, rather than a retry loop.
2. Set the CLI's permission mode/ask rules to require approval for a benign local
   command. Approve once, then reject a second request. Verify the command only
   runs after approval and rejection resolves the card without executing it.
3. Cancel while streaming and while awaiting approval. A late click on the old
   card must have no effect. Send another turn; it must start normally. Also retry
   a refused turn after changing permission mode or leaving plan mode; that change
   must still apply on retry.
4. Start a conversation with a unique synthetic marker. Restart Gram, reopen it
   and verify the agent remembers the marker. Reopen after a child-CLI exit and
   verify the stored session identity survives. Check missing-transcript errors.
5. Create a Git worktree, open/fork a thread there, edit a synthetic file and
   inspect its diff. Verify the working directory, additional writable roots,
   branch and conversation correspond to the chosen worktree.
6. Test restricted connector/confinement settings with your actual CLI config.
   Gram must refuse to start if any excluded MCP server remains enabled; ordinary
   subscription turns can still succeed. Do not disable
   the guard to get an acceptance test to pass. Confined Codex threads disable both
   plugin loading and the built-in ChatGPT apps feature, in addition to per-server
   configuration. Those capabilities load separately from `mcp_servers`; disabling
   app policy alone does not stop the apps server. Built-in web search remains governed
   by Codex’s configured policy; no always-on override is sent. The user’s config stays unchanged.
7. If you use a gateway, select it explicitly and grant helper context consent
   only to that exact endpoint. Remove its key and verify it cannot launch.
   Switching back to a local subscription must use the agent's own login.
8. Enable local dictation through the app's download/license consent. Verify
   macOS microphone permission, actual English transcription, cancellation and
   draft-only insertion. Native loading alone does not verify recognition quality.
   If consent or speech input requires the human, record the exact action still
   needed. A local synthetic 16 kHz mono PCM WAV may test the packaged recognizer,
   with its source/transcript recorded, but does not prove microphone capture or
   general transcription accuracy. Never upload acceptance audio.

Record results in the PR or release notes. Known limits are in [public readiness](../PUBLIC_RELEASE.md).
