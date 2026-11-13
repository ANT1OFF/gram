// Session policy: what a thread's role adds to its session when it
// opens, its role prompt, tools, MCP lists and outward gate, asked again on every open.
import {
  autonomyOf,
  orchestratorConnectors,
  orchestratorPeerMessaging,
  type PermissionMode,
  type Thread,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { type SessionPolicy } from "../../runtime/thread-runtimes.ts";
import { dreamRolePromptFor } from "../dream-prompt.ts";
import { plainPrompt, rolePrompt, workerPrompt } from "../prompt.ts";
import {
  admittedForRole,
  browserFor,
  modeAfterDowngrade,
  outwardGateFor,
  mcpListsFor,
  toolAudience,
} from "../rules.ts";
import { worktreesOf, type OrchestrationKit } from "./kit.ts";
/** The session policy each thread opens with. */
export const makeSessionPolicy = (kit: OrchestrationKit) => {
  const { store, findWorkspace, findThread, openedInAuto } = kit;

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
          ...(browserFor(thread, "plain", settings) ? { browser: true } : {}),
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
          ...(browserFor(thread, audience, settings) ? { browser: true } : {}),
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
          ...(browserFor(thread, audience, settings) ? { browser: true } : {}),
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

  /**
   * Every open of an orchestrator or a worker in `auto`, not only the first: a reopen can land
   * where its harness has no Auto (a Codex session under a gate the workspace gained, a CLI that
   * fell below the reviewer, an older joined machine), which it reports as `default`, and
   * `modeAfterDowngrade` moves it on to `bypassPermissions` (`observers.ts`).
   */
  const opening = (thread: Thread): Effect.Effect<void> =>
    Effect.sync(() => {
      if (thread.mode !== "auto") return;
      if (
        thread.role === "orchestrator" ||
        (thread.role === undefined && thread.spawnedBy !== undefined)
      )
        openedInAuto.add(thread.id);
    });

  /**
   * The downgrade `onUpsert` makes of an `auto` open's `default` report, made instead by a switch
   * before it lets queued input go, so its first turn is sent in the mode the session will keep.
   */
  const modeAfterSwitch = (thread: Thread): Effect.Effect<PermissionMode | undefined> =>
    Effect.sync(() => {
      if (!openedInAuto.has(thread.id) || thread.mode === "auto") return undefined;
      openedInAuto.delete(thread.id);
      return modeAfterDowngrade({ openedIn: "auto", reported: thread.mode });
    });

  return { policyFor, opening, modeAfterSwitch };
};
