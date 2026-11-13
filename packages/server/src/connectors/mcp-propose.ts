// `mcp_server_propose`: an agent proposes an MCP server, the user sees everything that would be
// written on a card, and only on their approval does Gram add it, through Settings → Connectors'
// own path (`claude mcp add-json`, and Codex's own config write through its app-server). What may
// be proposed is decided in `@gram/contracts` (`mcp-propose.ts`); this reads what each agent has
// under the name, raises the card and writes.

import { APP_TOOLS_SERVER_NAME } from "@gram/agents";
import {
  checkMcpServerProposal,
  effectiveCheckout,
  existingOf,
  MCP_SERVER_PROPOSE_TOOL,
  MCP_TARGET_LABEL,
  mcpServerProposalCard,
  mcpServerProposalSummary,
  McpServerProposeInput,
  SETTINGS_PROPOSAL_TTL_MS,
  type ConfiguredServer,
  type McpScope,
  type McpServerProposal,
  type McpTarget,
  type ThreadId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { defineAppTool } from "../app-tools/definition.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ConnectorConfigs } from "../rpc/handlers/connectors.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { askUser, fail } from "../settings/approval.ts";

export interface McpProposeToolOptions {
  /** How long a card waits for the user; `SETTINGS_PROPOSAL_TTL_MS` unless a test says. */
  readonly proposalTtl?: Duration.Input;
}

const TOOL = MCP_SERVER_PROPOSE_TOOL;

/** What each target has under the proposal's name now; fails when one's config can't be read. */
type Existing = Partial<Record<McpTarget, ConfiguredServer>>;

/** The same server, or none, as the card would show it: what decides whether an approval holds. */
const sameServer = (a: ConfiguredServer | undefined, b: ConfiguredServer | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : JSON.stringify(existingOf(a)) === JSON.stringify(existingOf(b));

/** Why `existing` can't be replaced as proposed, if it can't. */
const conflict = (proposal: McpServerProposal, existing: Existing) => {
  for (const target of proposal.targets) {
    const there = existing[target];
    if (there === undefined) continue;
    const label = MCP_TARGET_LABEL[target];
    const what = there.url ?? there.command ?? there.transport;
    if (!proposal.replace) {
      return `${label} already has an MCP server named ${proposal.name} (${there.scope}, ${what}). Pick another name, or propose again with replace: true; the card then shows both.`;
    }
    const scope = target === "codex" ? "user" : proposal.scope;
    if (there.scope !== scope) {
      return `${label}'s ${proposal.name} is in its ${there.scope} scope, not ${scope}, so this wouldn't replace it. The user changes it in Settings → Connectors.`;
    }
  }
  return undefined;
};

export const mcpProposeAppToolsLayer = (options: McpProposeToolOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* AppToolRegistry;
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { handlers: connectors, writes } = yield* ConnectorConfigs;
      const ttl = Duration.fromInputUnsafe(options.proposalTtl ?? SETTINGS_PROPOSAL_TTL_MS);

      /** The caller's checkout: where a `project` server's `.mcp.json` is, and what the CLI runs in. */
      const folderOf = (caller: ThreadId) =>
        store.getThread(caller).pipe(
          Effect.map((thread) => effectiveCheckout(thread).path),
          Effect.mapError(() => fail(TOOL, "Couldn't read this thread.")),
        );

      /** Each target's server named `name`, read afresh from its own config. */
      const existingIn = (folder: string, proposal: McpServerProposal) =>
        Effect.gen(function* () {
          const { agents } = yield* connectors["connectors.configured"]({
            cwd: folder,
            fresh: true,
          });
          const found: Existing = {};
          for (const target of proposal.targets) {
            const list = agents.find((agent) => agent.target === target);
            if (list === undefined || list.error !== undefined) {
              return yield* fail(
                TOOL,
                `Gram couldn't read ${MCP_TARGET_LABEL[target]}'s MCP config${
                  list?.error === undefined ? "" : ` (${list.error})`
                }, so it can't tell whether this would overwrite a server; nothing was proposed.`,
              );
            }
            const server = list.servers.find((s) => s.name === proposal.name);
            if (server !== undefined) found[target] = server;
          }
          return found;
        });

      const tool = defineAppTool({
        descriptor: {
          name: TOOL,
          // It raises its own card on every call, whatever the binding, mode or autonomy.
          class: "outwardGated",
          description:
            'Propose adding an MCP server to the user\'s agent CLIs. The user sees everything that would be written on a card and Gram adds it only if they approve; this call waits for the answer (applied, declined, or expired after 15 minutes). server: {type: "stdio", command, args?, env?} (runs a program on this machine) or {type: "http"|"sse", url, headers?}. targets: claude, codex or both. scope: user (default, every project) or project (the repo\'s .mcp.json; Claude Code only). Never include credentials: secret-looking env vars, headers, arguments or URLs are refused, and the user adds those by hand. A name already in use needs replace: true, and the card shows both. Say why in reason.',
        },
        audience: ["orchestrator", "plain", "worker"],
        input: McpServerProposeInput,
        rejectExcessProperties: true,
        handle: (caller, input) =>
          Effect.gen(function* () {
            // Who the caller is now, not which binding it was given.
            const role = yield* runtimes.audienceOf(caller);
            if (role === "dream") {
              return yield* fail(TOOL, "Memory updates don't propose MCP servers.");
            }
            const checked = checkMcpServerProposal(input, [APP_TOOLS_SERVER_NAME]);
            if (!checked.ok) {
              return yield* fail(TOOL, `Nothing was proposed. ${checked.errors.join(" ")}`);
            }
            const proposal = checked.proposal;
            const folder = yield* folderOf(caller);
            const existing = yield* existingIn(folder, proposal);
            const refused = conflict(proposal, existing);
            if (refused !== undefined) return yield* fail(TOOL, `Nothing was proposed. ${refused}`);
            const card = mcpServerProposalCard(proposal, folder, existing);
            const logged = {
              name: proposal.name,
              targets: proposal.targets.join(","),
              scope: proposal.scope,
              transport: proposal.config.type,
            };

            yield* askUser(
              runtimes,
              caller,
              TOOL,
              ttl,
              "MCP server",
              {
                displayName: card.action === "replace" ? "Replace MCP server" : "Add MCP server",
                input: card as unknown as Record<string, unknown>,
                description: mcpServerProposalSummary(card),
              },
              logged,
            );

            // The approval is for this card: this caller, this folder, and what each target held
            // when it was drawn. Anything else and nothing more is written.
            const roleNow = yield* runtimes.audienceOf(caller);
            const folderNow = yield* folderOf(caller).pipe(Effect.orElseSucceed(() => undefined));
            if (roleNow !== role || folderNow !== folder) {
              return yield* fail(
                TOOL,
                "This thread's role or folder changed while the card waited, so the approval no longer applies; nothing changed. Propose again if it's still wanted.",
              );
            }

            // Under the name's lock, which Settings' own adds and removes take too: each target's
            // server of the name is read again just before its write, so nothing written between
            // targets, or by anyone between the check and the write, is overwritten unshown.
            yield* writes.withName(
              proposal.name,
              Effect.gen(function* () {
                const done: Array<McpTarget> = [];
                for (const target of proposal.targets) {
                  const label = MCP_TARGET_LABEL[target];
                  const scope: McpScope = target === "codex" ? "user" : proposal.scope;
                  const already =
                    done.length === 0
                      ? ""
                      : ` ${done.map((t) => MCP_TARGET_LABEL[t]).join(", ")} already has it.`;
                  const now = yield* writes
                    .serverIn(target, folder, proposal.name)
                    .pipe(
                      Effect.mapError((error) =>
                        fail(
                          TOOL,
                          `Gram couldn't read ${label}'s MCP config (${error}); nothing was written to ${label}.${already}`,
                        ),
                      ),
                    );
                  if (!sameServer(existing[target], now)) {
                    return yield* fail(
                      TOOL,
                      `${label}'s ${proposal.name} changed after the card was drawn, so the approval no longer covers it; nothing was written to ${label}.${already} Propose again if it's still wanted.`,
                    );
                  }
                  // `claude mcp add-json` refuses a taken name, so the old entry goes first; Codex
                  // replaces its table in one write.
                  const replacing = existing[target] !== undefined && target === "claude";
                  if (replacing) {
                    yield* writes
                      .remove({ cwd: folder, name: proposal.name, scope, target })
                      .pipe(
                        Effect.mapError((e) =>
                          fail(TOOL, `${e.message}; nothing was replaced in ${label}.${already}`),
                        ),
                      );
                  }
                  yield* writes
                    .add({
                      cwd: folder,
                      scope,
                      name: proposal.name,
                      config: proposal.config,
                      targets: [target],
                    })
                    .pipe(
                      Effect.mapError((e) =>
                        fail(
                          TOOL,
                          `${e.message}${replacing ? `; the old ${proposal.name} was already removed from ${label}` : ""}.${already}`,
                        ),
                      ),
                    );
                  done.push(target);
                }
              }),
            );
            yield* Effect.logInfo("MCP server added by proposal").pipe(
              Effect.annotateLogs({ threadId: caller, role, action: card.action, ...logged }),
            );
            return {
              applied: true,
              name: proposal.name,
              action: card.action,
              written: card.targets.map((t) => `${t.label}: ${t.where}`),
              loading:
                "New sessions have it. Running sessions it reaches load it once idle, unless the user turned that off in Settings.",
              ...(card.notes === undefined ? {} : { notes: card.notes }),
            };
          }),
      });

      yield* registry.register([tool]);
    }),
  );

export const McpProposeAppToolsLive = mcpProposeAppToolsLayer();
