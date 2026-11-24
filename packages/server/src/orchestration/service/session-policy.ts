import {
  autonomyOf,
  orchestratorConnectors,
  orchestratorPeerMessaging,
  effectiveCheckout,
  hostOf,
  isLocalHost,
  VERIFY_FILE,
  type PermissionMode,
  type Thread,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type SessionPolicy } from "../../runtime/thread-runtimes.ts";
import { dreamRolePromptFor } from "../dream-prompt.ts";
import { plainPrompt, rolePrompt, workerPrompt } from "../prompt.ts";
import {
  admittedForRole,
  browserGrant,
  modeAfterDowngrade,
  outwardGateFor,
  mcpListsFor,
  toolAudience,
} from "../rules.ts";
import { worktreesOf, type OrchestrationKit } from "./kit.ts";

const hasVerifyRecipe = (thread: Thread): boolean => {
  const checkout = effectiveCheckout(thread);
  return isLocalHost(checkout) && existsSync(join(checkout.repoRoot ?? checkout.path, VERIFY_FILE));
};
/** The session policy each thread opens with. */
export const makeSessionPolicy = (kit: OrchestrationKit) => {
  const { store, findWorkspace, findThread, openedInAuto, workerMachinesOffered, joinedMachines } =
    kit;

  const policyFor = (thread: Thread): Effect.Effect<SessionPolicy> =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      const confined = thread.role === "dream" ? { confineWrites: true } : {};
      if (thread.role === undefined && thread.spawnedBy === undefined) {
        const instructions = plainPrompt({ agent: thread.model.agent });
        return {
          audience: "plain",
          outwardGate: undefined,
          ...confined,
          ...browserGrant(thread, "plain", settings),
          ...(instructions === undefined ? {} : { instructions }),
        };
      }
      const state = yield* findWorkspace(thread.workspaceId);
      const audience = toolAudience({ thread, workspace: state?.workspace });
      const outwardGate = outwardGateFor({
        thread,
        workspace: state?.workspace,
        charter: state?.charter,
      });
      if (audience === "orchestrator" && state !== undefined) {
        const projects = new Map((yield* store.listProjects).map((p) => [p.id, p]));
        const workerMachines = yield* workerMachinesOffered;
        return {
          audience,
          outwardGate,
          pinCwd: true,
          noBlockingAsk: true,
          ...(orchestratorPeerMessaging(settings) ? { peerMessaging: true } : {}),
          ...browserGrant(thread, audience, settings, state.charter),
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
            ...(workerMachines === undefined ? {} : { workerMachines }),
            projects: state.workspace.projectIds.flatMap((id) => {
              const project = projects.get(id);
              return project === undefined
                ? []
                : [
                    {
                      name: project.name,
                      root: project.root,
                      home: id === state.workspace.homeProjectId,
                      folder:
                        state.workspace.fromProfile === true &&
                        id === state.workspace.homeProjectId,
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
          noBlockingAsk: true,
          ...browserGrant(thread, audience, settings, state?.charter),
          ...mcpListsFor({ audience, orchestrated: undefined, charter: state?.charter }),
          instructions: workerPrompt({
            feature: thread.spawnedBy.feature,
            orchestratorTitle: orchestrator?.title ?? "an orchestrator that has since closed",
            autonomy:
              outwardGate === "all"
                ? "supervised"
                : outwardGate === "irreversible"
                  ? "publish"
                  : "full",
            agent: thread.model.agent,
            gated: outwardGate !== undefined,
            ...(hasVerifyRecipe(thread) ? { verifyRecipe: true } : {}),
            ...(joinedMachines().some(
              (machine) =>
                machine.onDemand === "worker" && machine.id === hostOf(effectiveCheckout(thread)),
            )
              ? { ownMachine: true }
              : {}),
            ...(extras.length === 0
              ? {}
              : { alsoIn: worktreesOf(yield* store.listProjects, extras) }),
          }),
        };
      }
      if (thread.role === "dream" && admittedForRole(thread.model.agent, "dream")) {
        return {
          audience: "plain",
          outwardGate,
          instructions: dreamRolePromptFor(thread.model.agent),
          ...confined,
        };
      }
      return { audience: "plain", outwardGate, ...confined };
    });

  const opening = (thread: Thread): Effect.Effect<void> =>
    Effect.sync(() => {
      if (thread.mode !== "auto") return;
      if (
        thread.role === "orchestrator" ||
        (thread.role === undefined && thread.spawnedBy !== undefined)
      )
        openedInAuto.add(thread.id);
    });

  const modeAfterSwitch = (thread: Thread): Effect.Effect<PermissionMode | undefined> =>
    Effect.sync(() => {
      if (!openedInAuto.has(thread.id) || thread.mode === "auto") return undefined;
      openedInAuto.delete(thread.id);
      return modeAfterDowngrade({ openedIn: "auto", reported: thread.mode });
    });

  return { policyFor, opening, modeAfterSwitch };
};
