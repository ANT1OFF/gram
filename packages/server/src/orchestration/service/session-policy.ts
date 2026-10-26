// Session policy: what a thread's role adds to its session when it
// opens, its role prompt, tools, MCP lists and outward gate, asked again on every open.
import {
  autonomyOf,
  orchestratorConnectors,
  orchestratorPeerMessaging,
  type Thread,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { type SessionPolicy } from "../../runtime/thread-runtimes.ts";
import { dreamRolePromptFor } from "../dream-prompt.ts";
import { plainPrompt, rolePrompt, workerPrompt } from "../prompt.ts";
import { admittedForRole, outwardGateFor, mcpListsFor, toolAudience } from "../rules.ts";
import { worktreesOf, type OrchestrationKit } from "./kit.ts";
/** The session policy each thread opens with. */
export const makeSessionPolicy = (kit: OrchestrationKit) => {
  const { store, findWorkspace, findThread } = kit;

  // ---------------------------------------------------------------------------------------
  // Session policy
  // ---------------------------------------------------------------------------------------

  const policyFor = (thread: Thread): Effect.Effect<SessionPolicy> =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      // Every Dream drops external connectors. The runtime selects file-only tools or guided
      // normal native permissions separately.
      const confined = thread.role === "dream" ? { confineWrites: true } : {};
      if (thread.role === undefined && thread.spawnedBy === undefined) {
        const instructions = plainPrompt({ agent: thread.model.agent });
        return {
          audience: "plain",
          outwardGate: undefined,
          ...confined,
          ...(instructions === undefined ? {} : { instructions }),
        };
      }
      const state = yield* findWorkspace(thread.workspaceId);
      const audience = toolAudience({ thread, workspace: state?.workspace });
      // The gate follows the workspace's autonomy, and is fixed for the session's life:
      // `setCharter` reloads the sessions when the level changes.
      const outwardGate = outwardGateFor({
        thread,
        workspace: state?.workspace,
        charter: state?.charter,
      });
      if (audience === "orchestrator" && state !== undefined) {
        const projects = new Map((yield* store.listProjects).map((p) => [p.id, p]));
        return {
          audience,
          outwardGate,
          // It runs unattended: its shell stays home, it asks through `ask_user` rather than a
          // tool that holds its turn overnight, and on Claude it gets the user's connectors as
          // listed or, listing none, only where tool search defers their schemas. On every
          // agent, only those its workspace gives.
          pinCwd: true,
          noBlockingAsk: true,
          // Only where the user lets it, and only outward: the agent's own peer messaging would
          // reach a session past Gram's routing, so workers and plain threads never have it.
          ...(orchestratorPeerMessaging(settings) ? { peerMessaging: true } : {}),
          ...mcpListsFor({
            audience,
            orchestrated:
              thread.model.agent === "claude" ? orchestratorConnectors(settings) : undefined,
            charter: state.charter,
          }),
          instructions: rolePrompt({
            workspaceName: state.workspace.name,
            autonomy: autonomyOf(state.charter),
            agent: thread.model.agent,
            gated: outwardGate !== undefined,
            projects: state.workspace.projectIds.flatMap((id) => {
              const project = projects.get(id);
              return project === undefined
                ? []
                : [
                    {
                      name: project.name,
                      root: project.root,
                      home: id === state.workspace.homeProjectId,
                    },
                  ];
            }),
          }),
        };
      }
      if (audience === "worker" && thread.spawnedBy !== undefined) {
        const orchestrator = yield* findThread(thread.spawnedBy.threadId);
        const extras = thread.extraCheckouts ?? [];
        return {
          audience,
          outwardGate,
          ...mcpListsFor({ audience, orchestrated: undefined, charter: state?.charter }),
          instructions: workerPrompt({
            feature: thread.spawnedBy.feature,
            orchestratorTitle: orchestrator?.title ?? "an orchestrator that has since closed",
            // What the prompt says will ask has to be what the session's gate asks about, so it
            // is read off the gate: a worker left with the strictest one is told exactly that.
            autonomy:
              outwardGate === "all"
                ? "supervised"
                : outwardGate === "irreversible"
                  ? "publish"
                  : "full",
            agent: thread.model.agent,
            gated: outwardGate !== undefined,
            ...(extras.length === 0
              ? {}
              : { alsoIn: worktreesOf(yield* store.listProjects, extras) }),
          }),
        };
      }
      // The runtime binds the Dream audience and standing instructions on every reopen.
      if (thread.role === "dream" && admittedForRole(thread.model.agent, "dream")) {
        return {
          audience: "plain",
          outwardGate,
          instructions: dreamRolePromptFor(thread.model.agent),
          ...confined,
        };
      }
      // A role outside its slot, or on an agent kind that isn't admitted: no tools and no
      // delegation, but the accident gate stays for as long as the thread carries the marks.
      return { audience: "plain", outwardGate, ...confined };
    });

  return { policyFor };
};
