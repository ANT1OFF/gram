# A joined machine's Claude sign-in from a token

[Up: other machines](../MACHINES.md)

Each joined machine needs Claude Code signed in for its sessions. Today that means a
`claude /login` on every one: the **Sign in** button in Settings → Machines opens a terminal on
the machine to run it. This note covers a second way, offered beside that button: **Use a token
from this Mac**. Gram runs `claude setup-token` on the main machine, and with the user's consent
for each machine, it sends the token it prints to the machines the user picks.

This is a narrow exception to a standing rule. Gram never reads provider credentials. It only
drives the user's own CLIs. The exception covers only the token that `claude setup-token`
prints, only after the user consents, and only for the machines the user names. Gram never
reads the Keychain, `~/.claude/.credentials.json` or any other credential to do this.

## What `claude setup-token` does

From Claude Code's [authentication docs][auth] ("Generate a long-lived token") and
`claude setup-token --help` in Claude Code 2.1.319 ("Set up a long-lived authentication token
(requires Claude subscription)"):

- **What it prints.** It opens the same browser authorization flow as `/login`. After the user
  approves in the browser, it prints the token to the terminal. It doesn't save the token
  anywhere.
- **Lifetime.** The OAuth token lasts one year.
- **Scope.** It uses the user's Claude subscription (Pro, Max, Ultra, Team or Enterprise). It can
  only make model requests. It can't start Remote Control sessions or fetch claude.ai connectors.
  MCP servers configured on the machine itself still work.
- **How it is used.** It is set as `CLAUDE_CODE_OAUTH_TOKEN` in the environment of the `claude`
  process. In [authentication precedence][precedence] it ranks above the `/login` credential, so
  when the token is set, the machine uses it in place of its own sign-in. `--bare` doesn't read
  it. Gram never passes `--bare`.
- **Revocation.** There is no CLI command to revoke it. The user revokes it at claude.ai, under
  Settings → Claude Code, where these tokens are listed without labels. Until it is revoked, the
  token works for anyone who holds it.

Gram's subscription check already accepts this token. `claude auth status --json` reports
`authMethod: "oauth_token"` (or the variable's name on older versions), and Gram counts that as a
subscription login ([binary.ts](../../packages/agents/src/claude/binary.ts)).

[auth]: https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
[precedence]: https://code.claude.com/docs/en/authentication#authentication-precedence

## Consent

The option sits on each machine row in Settings → Machines, beside **Sign in**. Choosing it opens
a dialog before anything runs:

> **Use a Claude token from this Mac**
>
> Gram runs `claude setup-token` on this Mac. You approve it in your browser, and Claude Code
> prints a token that signs in to your subscription for one year.
>
> - Gram reads the token from that command's output on this Mac. It isn't shown on screen,
>   written to disk here, or logged.
> - It is sent only to the machines you tick below, over the machine's own connection to this
>   Gram through Tailscale.
> - Each machine keeps it in its gram-host folder, readable only by your user there. It is used
>   only for the Claude sessions Gram starts on that machine, in place of that machine's own
>   sign-in.
> - **Forget token** or **Remove** in Settings → Machines deletes it from the machine.
> - Deleting it doesn't revoke it. To revoke it, go to claude.ai → Settings → Claude Code.
>
> ☑ _machine-a_ (the one whose row was clicked) ☐ _machine-b_ … (other machines that are online)
>
> [Cancel] [Run setup-token]

- Consent is given per machine, by ticking it. Only the machine the user started from is ticked
  at first. There is no global switch and no "always". Every run asks again.
- Only confirmed machines that are online can be ticked. A token is never queued for a machine
  that is offline.
- Gram starts `claude setup-token` only once the user confirms the dialog. The request names
  the machines and carries an explicit consent field. The server refuses a request without one,
  with no machines, or with a machine that isn't confirmed and online.
- While it runs, the dialog shows the sign-in page's link (to reopen it if the browser didn't
  open), a field for the code Claude Code asks for when the browser can't redirect back, and
  **Cancel**. The terminal output itself never reaches the page.
- When it ends, the dialog shows a result for each machine: either a token was set, or why it
  wasn't (offline, its gram-host is too old, it refused).
- Consent is for the join the user ticked. A machine removed after it was ticked gets nothing
  from that run, even if it joins again with the same key: its join is compared when the token
  is sent, and Remove drops it from the run.

**Keep for future machines.** The brief allows an opt-in to keep the token on the main machine
for machines joined later. This design leaves it out, and recommends against it. Keeping it would
put a one-year credential at rest on the main machine, outside the Keychain, for a small
convenience. Running setup-token again for a new machine costs one browser approval.

## Capture and transport

- **Capture.** The server finds the user's `claude` the way a session does: the login shell's
  `command -v claude` and environment, read only between the probe's markers. It then starts
  `claude setup-token` itself, by its absolute path, in a pseudo-terminal. No shell runs in that
  terminal, so nothing a shell profile prints (a `set -x` trace of an exported token, say) is ever
  read as its output. The terminal is 1000 columns wide, so the token and the sign-in link each
  print on one line.
- **The process that holds the token.** Its environment is the login shell's, without anything
  that could attach a debugger or inspector (`NODE_OPTIONS`, `NODE_INSPECT*`, `BUN_INSPECT*`),
  preload code (`LD_PRELOAD`, `DYLD_*`, `BASH_ENV`), log requests (`NODE_DEBUG`, `DEBUG`,
  `ANTHROPIC_LOG`) or read or bypass its TLS (`SSLKEYLOGFILE`, `NODE_TLS_REJECT_UNAUTHORIZED`), and
  without any `CLAUDE_CODE_OAUTH_TOKEN` already set (`tokenChildEnv`). The Agent SDK's and Claude
  Code's own debug, recording and raw-logging switches go too (`DEBUG_*`, `CLAUDE_DEBUG`,
  `CLAUDE_CODE_DEBUG*`, `CLAUDE_CODE_TERMINAL_RECORDING`, `CLAUDE_PTY_RECORD`, `VCR_RECORD` and
  others): SDK 0.3.311 turns `DEBUG_CLAUDE_AGENT_SDK` into `DEBUG=1` for its child. The same rule
  applies on the joined machine to every Claude process that gets the token, and again at Gram's
  spawn of a session's child, after the SDK's own changes to its env.
- **Reading the output.** The server strips ANSI from the output and looks for three things: the
  sign-in link, the code prompt, and a token (`sk-ant-oat<NN>-…`), each only once it is whole. A
  link reaches the page only when it is Claude's own authorization page (`https://claude.ai` or
  `claude.com`, `/oauth/authorize`), with no credentials, port or fragment, and each query
  parameter in its own grammar: `code=true`, a UUID `client_id`, a 43-or-so character
  `code_challenge` and `state`, a short `scope` and a Claude or loopback `redirect_uri`. No grammar
  admits `%` or a value long enough to hold a token. A link that doesn't parse is dropped. It keeps at most 64 KiB of output in memory.
  Once it finds a token, it stops the process and throws the buffer away. The token is held as an
  Effect `Redacted`, which prints as `<redacted>`, until each machine has answered. Then the
  reference is dropped. If no token comes within 10 minutes, the run is cancelled.
- **Transport.** The token goes only over the existing host channel: the machine's own
  WebSocket to this Gram's `https://….ts.net` address, signed with its key at each dial. It
  travels as one typed RPC, `host.claude.setToken`, whose payload schema is
  `Schema.RedactedFromValue(Schema.String)`. It is never in a URL, a query string, an HTTP route
  body to or from the page, a command line or an environment variable on the main machine.
- **Not persisted on the main machine.** No database row, settings file, log line or crash
  report holds it. The machines store records only `claudeTokenSetAt` for each machine, a time
  and nothing else. It is written before the token is sent, so a machine whose reply was lost
  still counts as holding one. If it can't be written, nothing is sent to that machine.
- **Logs and errors.** An error says which step failed, never what was received. The host
  rejects a malformed token without quoting it. A host's refusal reaches the page only in the
  words built here: the step and one of a fixed set of file error codes. Any other text a host sends
  is replaced by a fixed message. Diagnostics' redaction patterns also match
  `sk-ant-oat…`, so a log line that would carry a token by accident is masked. A test checks
  that a synthetic token appears in none of the logs, errors, status replies or RPC failures of
  the flow.

## Storage on the joined machine

- The token is kept in `claude-oauth-token` in the host's folder (`GRAM_HOST_HOME`, Application
  Support on a Mac, `~/.config/gram-host` on Linux). It is written like `host-key.pem`: mode
  `0600` in a `0700` folder, created exclusively, replaced atomically, and read without following
  a link. A file that isn't private to the user is refused.
- `gram-host run` reads the file each time it prepares a Claude session. It sets
  `CLAUDE_CODE_OAUTH_TOKEN` only in the environment of the `claude` processes it starts. A token
  set or forgotten applies to new sessions, and sessions already running keep the sign-in they
  started with.
- It never goes in a shell profile, the launchd plist, the systemd unit or `host.json`. The local
  host that the main Gram starts as its own child never reads it.

## Removal

- **Forget token** in Settings → Machines asks the machine to delete the file
  (`host.claude.forgetToken`). It then uses its own `claude /login` sign-in again, if it has one.
- **Remove** holds the machine for the whole operation: no run can start for it and no send to it
  can begin, and every send already in flight, from any run, is answered first. Then, while the
  machine is online, it asks it to delete any token, recorded or not, and only then forgets the
  machine, so the delete is the last thing it receives. If the machine is offline and may hold a
  token, Remove says so. **Forget token** holds the machine the same way while it deletes. The token stays
  there until `gram-host leave` runs on that machine, or until the user revokes it at claude.ai.
- `gram-host leave` deletes the token along with the join and its key.

## Threat model

| Threat                          | What happens                                                                                                                                           | Mitigation                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A joined machine is compromised | Its user can read the token and use the subscription for up to a year, from anywhere.                                                                  | Consent is per machine and names this risk. Revoke at claude.ai. The token only makes model requests: it can't reach connectors or Remote Control. |
| A join link is stolen           | A machine that joins with it still waits for the user to confirm its fingerprint, and only confirmed, online machines can be picked.                   | Existing join confirmation. The token is never queued for a machine.                                                                               |
| The token leaks into logs       | The token is `Redacted` in the RPC schema. No log or error includes received text. Diagnostics masks `sk-ant-oat…`.                                    | Redaction test.                                                                                                                                    |
| The token leaks in a crash dump | It sits in the main server's memory only for the run, and in each `claude` process's environment on the joined machine, which only that user can read. | The reference is dropped after sending. No file on the main machine.                                                                               |
| Another page drives the flow    | The `/machines/*` routes answer only the local app (same-origin POST with an Origin, never a paired phone or a machine).                               | Same guard as Add a machine.                                                                                                                       |
| The token lives a long time     | It lasts one year. Deleting it on a machine doesn't revoke it.                                                                                         | The dialog and Forget token both point to revocation at claude.ai.                                                                                 |
| The machine had its own sign-in | The token outranks `/login`, so its sessions bill the subscription the token belongs to.                                                               | The dialog says so. Forget token restores the machine's own sign-in.                                                                               |

## Out of scope

- Codex. It has no equivalent of this flow, and Codex sessions don't run on joined machines yet.
- Rotation and expiry warnings. Gram records when each machine got a token, but doesn't warn
  before the year is up.
- Revoking from Gram. There is no API for it, so the user revokes at claude.ai.
- Verifying against the live CLI. The capture is tested with a synthetic `setup-token` that
  prints in the format the docs describe. The first live run is the user's.
