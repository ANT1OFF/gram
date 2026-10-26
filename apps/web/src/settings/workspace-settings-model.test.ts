import {
  Autonomy,
  DEFAULT_AUTONOMY,
  DEFAULT_CHARTER,
  type ModelRef,
  type OrchestratorCharter,
  type ProfileId,
  type ProjectId,
  type WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  connectorChoice,
  connectorSuggestions,
  withConnectors,
  addWorkerModel,
  AUTONOMY_LEVELS,
  autonomyLevel,
  presentAutonomy,
  autonomyNeedsConfirm,
  emptyWorkspaceDraft,
  defaultWorkerIndex,
  FOLLOW_DEFAULT_MODE,
  gateNote,
  harnessNotes,
  projectNameOf,
  removableRepos,
  sameModelRef,
  sameRoster,
  toggleDraftProject,
  validateWorkspaceDraft,
  withAutonomy,
  withDefaultWorker,
  withOrchestratorModel,
  withWorkerCap,
  withWorkerMode,
  withWorkerModels,
  withWorkerNote,
  withoutWorkspaceRepo,
  withWorkspaceRepo,
  WORKER_MODE_CHOICES,
  workerModeLabel,
  workerModelIssues,
  WORKERS_AT_ONCE,
} from "./workspace-settings-model";
import { parseNumberDraft } from "./number-draft";
import { SOL_ROSTER } from "./roster-test-fixtures";

const api = "p-api" as ProjectId;
const web = "p-web" as ProjectId;

describe("parseNumberDraft", () => {
  const whole = { min: 1, integer: true };

  it("takes a number in range", () => {
    expect(parseNumberDraft(" 12 ", whole)).toBe(12);
    expect(parseNumberDraft("0.5", { min: 0.5, integer: false })).toBe(0.5);
  });

  it("refuses blanks, words, fractions of a whole and anything below the minimum", () => {
    expect(parseNumberDraft("", whole)).toBeUndefined();
    expect(parseNumberDraft("many", whole)).toBeUndefined();
    expect(parseNumberDraft("1.5", whole)).toBeUndefined();
    expect(parseNumberDraft("0", whole)).toBeUndefined();
    expect(parseNumberDraft("-3", whole)).toBeUndefined();
    expect(parseNumberDraft("Infinity", whole)).toBeUndefined();
  });
});

describe("the charter's worker cap", () => {
  it("changes and leaves the rest of the charter alone", () => {
    expect(withWorkerCap(DEFAULT_CHARTER, 3)).toEqual({
      ...DEFAULT_CHARTER,
      maxConcurrentWorkers: 3,
    });
    expect(WORKERS_AT_ONCE.min).toBeGreaterThanOrEqual(1);
  });
});

describe("the charter's autonomy", () => {
  it("offers every level the contract has, from the most asked to the least", () => {
    expect(AUTONOMY_LEVELS.map((level) => level.value)).toEqual(Autonomy.literals);
    expect(AUTONOMY_LEVELS.filter((level) => level.warn).map((level) => level.value)).toEqual([
      "full",
    ]);
    expect(autonomyLevel("supervised").description).toBe(
      "Asks before anything leaves your machine: a push, a pull request, a merge.",
    );
    expect(autonomyLevel("full").detail).toContain("branch protection, required reviews");
    // One line each, with the rest behind "Learn more".
    for (const level of AUTONOMY_LEVELS) {
      expect(level.description.split(/\s+/).length).toBeLessThanOrEqual(15);
    }
    // A chip names a level this build doesn't know by its own word, not as another level.
    expect(presentAutonomy("full")).toMatchObject({ label: "Full", warn: true });
    expect(presentAutonomy("unattended")).toMatchObject({ label: "unattended", warn: false });
  });

  it("is written out once picked, even when it is the default", () => {
    expect(withAutonomy(DEFAULT_CHARTER, DEFAULT_AUTONOMY)).toEqual({
      ...DEFAULT_CHARTER,
      autonomy: "publish",
    });
    expect(withAutonomy({ ...DEFAULT_CHARTER, autonomy: "full" }, "supervised").autonomy).toBe(
      "supervised",
    );
  });

  it("confirms only the step up to Full", () => {
    expect(autonomyNeedsConfirm("publish", "full")).toBe(true);
    expect(autonomyNeedsConfirm("supervised", "full")).toBe(true);
    expect(autonomyNeedsConfirm("full", "full")).toBe(false);
    expect(autonomyNeedsConfirm("full", "publish")).toBe(false);
    expect(autonomyNeedsConfirm("supervised", "publish")).toBe(false);
  });

  it("qualifies the gate only while something still asks", () => {
    expect(gateNote("supervised")?.detail).toContain("git push, gh pr create, gh pr merge");
    expect(gateNote("publish")?.line).toContain("an accident gate, not a security boundary");
    expect(gateNote("publish")?.detail).not.toContain("gh pr create");
    expect(gateNote("full")).toBeUndefined();
  });
});

describe("workspace draft", () => {
  it("makes the first ticked project the home, and hands the role on when it is unticked", () => {
    const one = toggleDraftProject(emptyWorkspaceDraft, api, true);
    expect(one).toMatchObject({ projectIds: [api], homeProjectId: api });
    const two = toggleDraftProject(one, web, true);
    expect(two).toMatchObject({ projectIds: [api, web], homeProjectId: api });
    expect(toggleDraftProject(two, api, false)).toMatchObject({
      projectIds: [web],
      homeProjectId: web,
    });
    expect(toggleDraftProject(one, api, false)).toMatchObject({
      projectIds: [],
      homeProjectId: undefined,
    });
    expect(toggleDraftProject(two, web, true)).toEqual(two);
  });

  it("says what is missing", () => {
    expect(validateWorkspaceDraft(emptyWorkspaceDraft)).toEqual({
      error: "Give the workspace a name.",
    });
    expect(validateWorkspaceDraft({ ...emptyWorkspaceDraft, name: "platform" })).toEqual({
      error: "Pick at least one repository.",
    });
    expect(
      validateWorkspaceDraft({ name: "platform", projectIds: [api], homeProjectId: web }),
    ).toEqual({ error: "The home repository must be one of the workspace's repositories." });
  });

  it("trims the name, and carries the id only when editing", () => {
    const draft = { name: " platform ", projectIds: [api, web], homeProjectId: web };
    expect(validateWorkspaceDraft(draft)).toEqual({
      input: { name: "platform", projectIds: [api, web], homeProjectId: web },
    });
    expect(validateWorkspaceDraft(draft, "w-1" as WorkspaceId)).toEqual({
      input: { id: "w-1", name: "platform", projectIds: [api, web], homeProjectId: web },
    });
  });

  it("falls back to the id for a project that has been removed", () => {
    expect(projectNameOf([], api)).toBe("p-api");
  });
});

describe("a workspace's repos", () => {
  const docs = "p-docs" as ProjectId;
  const workspace = {
    id: "w-1" as WorkspaceId,
    name: "platform",
    projectIds: [api, web] as [ProjectId, ...ProjectId[]],
    homeProjectId: api,
    createdAt: 0,
  };

  it("adds a repo once, keeping the name and the home", () => {
    const input = { id: "w-1", name: "platform", homeProjectId: api };
    expect(withWorkspaceRepo(workspace, docs)).toEqual({ ...input, projectIds: [api, web, docs] });
    expect(withWorkspaceRepo(workspace, web)).toEqual({ ...input, projectIds: [api, web] });
  });

  it("lets any repo but the home project go", () => {
    expect(removableRepos(workspace)).toEqual([web]);
    expect(withoutWorkspaceRepo(workspace, web)).toEqual({
      input: { id: "w-1", name: "platform", projectIds: [api], homeProjectId: api },
    });
    expect(withoutWorkspaceRepo(workspace, api)).toEqual({
      error: "The home repository stays. Make another one home first.",
    });
  });
});

describe("worker models", () => {
  const charter: OrchestratorCharter = { maxConcurrentWorkers: 10 };
  const claude: ModelRef = { agent: "claude", model: "opus" };
  const codex: ModelRef = { agent: "codex", model: "gpt-5-codex" };
  const profiled: ModelRef = { ...codex, profileId: "pr-1" as ProfileId };

  it("keeps the list on the charter, without duplicates, and drops an empty one", () => {
    const one = withWorkerModels(charter, addWorkerModel([], claude));
    expect(one.workerModels).toEqual([claude]);
    expect(addWorkerModel([claude], { ...claude })).toEqual([claude]);
    expect(addWorkerModel([claude], { ...claude, variant: "high" })).toHaveLength(2);
    expect(addWorkerModel([codex], profiled)).toHaveLength(2);
    expect("workerModels" in withWorkerModels(one, [])).toBe(false);
    expect(sameModelRef(profiled, { ...profiled })).toBe(true);
  });

  it("keeps a note per model, one default, and an orchestrator model of the workspace's own", () => {
    const roster = withWorkerNote([claude, profiled], 1, "  reviews, bug hunts ");
    expect(roster).toEqual([claude, { ...profiled, useFor: "reviews, bug hunts" }]);
    expect(withWorkerNote(roster, 1, " ")).toEqual([claude, profiled]);
    expect(addWorkerModel(roster, { ...profiled, useFor: "audits" })).toBe(roster);

    const marked = withDefaultWorker(roster, 1);
    expect(defaultWorkerIndex(marked)).toBe(1);
    const moved = withDefaultWorker(marked, 0);
    expect(moved.map((model) => model.default)).toEqual([true, undefined]);
    expect(defaultWorkerIndex(withDefaultWorker(moved, 0))).toBeUndefined();

    const own = withOrchestratorModel(charter, claude);
    expect(own.orchestratorModel).toEqual(claude);
    expect("orchestratorModel" in withOrchestratorModel(own, undefined)).toBe(false);
  });

  it("holds workers to a mode, or follows the default rule again", () => {
    const held = withWorkerMode(charter, "acceptEdits");
    expect(held.workerMode).toBe("acceptEdits");
    expect("workerMode" in withWorkerMode(held, FOLLOW_DEFAULT_MODE)).toBe(false);
    // The wizard and Settings offer the same choices; "follow" names only a mode-less charter.
    expect(WORKER_MODE_CHOICES.map((choice) => choice.value)).toEqual([
      "auto",
      "acceptEdits",
      "default",
      "bypassPermissions",
    ]);
    expect(workerModeLabel("acceptEdits")).toBe("Accept edits");
    expect(workerModeLabel(undefined)).toBe("Follow the default");
  });

  it("warns about what the server will refuse or pass over at spawn, and only that", () => {
    const models = [
      claude,
      codex,
      profiled,
      { agent: "grok", model: "synthetic-grok" } as ModelRef,
    ];
    // Native gate readiness belongs to the server; Settings does not assume a gateway is needed.
    for (const autonomy of ["supervised", "publish", "full"] as const) {
      expect(
        workerModelIssues({ workerModels: models, autonomy }).map((issue) => issue.index),
      ).toEqual([3]);
    }
    expect(workerModelIssues({})).toEqual([]);
    // A profile deleted since, or one with no key, leaves its entries with nothing to run on.
    const keyed = [{ id: "pr-1", keyRef: "vault:pr-1" }];
    expect(workerModelIssues({ workerModels: [profiled] }, { profiles: keyed })).toEqual([]);
    expect(workerModelIssues({ workerModels: [profiled] }, { profiles: [] })[0]).toMatchObject({
      message: expect.stringContaining("the gateway profile it ran on is gone"),
      unavailable: { fix: "workspaces" },
    });
    expect(
      workerModelIssues({ workerModels: [profiled] }, { profiles: [{ id: "pr-1", keyRef: "" }] }),
    ).toEqual([
      {
        index: 0,
        message: "Unavailable until its gateway profile has a key; a spawn on it gets the default.",
        unavailable: { fix: "gateways" },
      },
    ]);
  });

  it("calls the default Sol entry unavailable while there is no gateway, and says where to fix it", () => {
    const sol = SOL_ROSTER[1]!;
    const roster = { workerModels: SOL_ROSTER, autonomy: "full" as const };
    // Codex on its own login offers its own models, not the gateway's.
    expect(workerModelIssues(roster, { ownModels: { codex: ["gpt-5.5"] } })).toEqual([
      {
        index: 1,
        message: `Unavailable: Codex does not list ${sol.model} on your local account. Choose a listed model in Settings → Workspaces; a spawn on it gets the default.`,
        unavailable: { fix: "workspaces" },
      },
    ]);
    expect(workerModelIssues(roster, { ownModels: { codex: null } })[0]?.message).toBe(
      "Unavailable: Codex couldn't list local models, so a spawn on it gets the default.",
    );
    // Not listed yet says nothing, and on a keyed profile it runs.
    expect(workerModelIssues(roster)).toEqual([]);
    const onGateway = [SOL_ROSTER[0]!, { ...sol, profileId: "pr-1" as ProfileId }];
    expect(
      workerModelIssues(
        { workerModels: onGateway },
        { profiles: [{ id: "pr-1", keyRef: "vault:pr-1" }], ownModels: { codex: null } },
      ),
    ).toEqual([]);
    // A gateway added since takes up the entry with no profile, as the server does, once it lists Sol.
    const solGateway = { id: "gw", keyRef: "vault:gw", models: [{ id: sol.model }] };
    expect(
      workerModelIssues(roster, { profiles: [solGateway], ownModels: { codex: null } })[0]
        ?.unavailable?.fix,
    ).toBe("agents");
    expect(
      workerModelIssues(
        { workerModels: [{ ...sol, profileId: "gw" as ProfileId }] },
        { profiles: [{ ...solGateway, models: [{ id: "gpt-5.5" }] }] },
      )[0],
    ).toMatchObject({
      message: expect.stringContaining(`its gateway profile doesn't offer ${sol.model}`),
      unavailable: { fix: "workspaces" },
    });
    // Sol on a gateway the user picked isn't the built-in unpinned roster, so it can be saved as it is.
    expect(sameRoster(onGateway, SOL_ROSTER)).toBe(false);
    expect(sameRoster([...SOL_ROSTER], SOL_ROSTER)).toBe(true);
    expect(sameRoster([onGateway[1]!], SOL_ROSTER)).toBe(false);
  });

  it("keeps local models local unless a profile is explicitly chosen", () => {
    const sol = SOL_ROSTER[1]!;
    const roster = { workerModels: SOL_ROSTER, autonomy: "full" as const };
    const own = { codex: [sol.model] };
    expect(workerModelIssues(roster, { ownModels: own })).toEqual([]);
    // A keyed gateway that hasn't listed its models doesn't take a local entry up.
    const unfetched = [{ id: "example", keyRef: "vault:example", models: [] }];
    expect(workerModelIssues(roster, { profiles: unfetched, ownModels: own })).toEqual([]);
    expect(
      workerModelIssues(roster, { profiles: unfetched, ownModels: { codex: ["gpt-5.5"] } })[0]
        ?.unavailable?.fix,
    ).toBe("workspaces");
  });

  it("explains a harness only while it is relevant: in the list, or the default model's", () => {
    expect(harnessNotes([claude])).toEqual([]);
    expect(harnessNotes([claude], "claude")).toEqual([]);
    expect(harnessNotes([codex, profiled]).map((note) => note.agent)).toEqual(["codex"]);
    const both = harnessNotes([{ agent: "grok", model: "m" }, claude], "codex");
    expect(both.map((note) => note.agent)).toEqual(["codex"]);
    expect(both[0]?.notes).toContain(
      "Known gap: a command typed into an interactive shell Codex opened is not asked about.",
    );
    expect(harnessNotes([codex], "codex")).toHaveLength(1);
  });
});

describe("the charter's connector set", () => {
  it("reads every connector without a set, and switches lists keeping what they list", () => {
    expect(connectorChoice(DEFAULT_CHARTER)).toEqual({ mode: "all", entries: [] });
    const allow = withConnectors(DEFAULT_CHARTER, "allow", ["parse"]);
    expect(allow.connectors).toEqual({ allow: ["parse"] });
    expect(connectorChoice(allow)).toEqual({ mode: "allow", entries: ["parse"] });
    const deny = withConnectors(allow, "deny", connectorChoice(allow).entries);
    expect(deny.connectors).toEqual({ deny: ["parse"] });
    expect(withConnectors(deny, "all", ["parse"])).toEqual(DEFAULT_CHARTER);
  });

  it("offers servers by name and a claude.ai connector only by its address", () => {
    expect(
      connectorSuggestions([
        {
          target: "claude",
          signIn: "liveOnly",
          servers: [
            { name: "parse", transport: "stdio", scope: "user", carriesValues: false },
            {
              name: "claude.ai Teams",
              transport: "other",
              scope: "claudeai",
              url: "https://mcp.example.invalid/teams",
              carriesValues: false,
            },
            {
              name: "claude.ai Gmail",
              transport: "other",
              scope: "claudeai",
              carriesValues: false,
            },
            {
              name: "claude.ai Keyed",
              transport: "other",
              scope: "claudeai",
              url: "https://keyed.example/mcp?key=••••",
              carriesValues: false,
            },
            {
              name: "claude.ai Tokened",
              transport: "other",
              scope: "claudeai",
              url: "https://organization.example.invalid/[redacted]/mcp",
              carriesValues: false,
            },
          ],
        },
        {
          target: "codex",
          signIn: "onRequest",
          servers: [{ name: "parse", transport: "stdio", scope: "user", carriesValues: false }],
        },
      ]),
    ).toEqual([
      { entry: "https://mcp.example.invalid/teams", label: "claude.ai Teams" },
      { entry: "parse", label: "Claude Code, Codex" },
    ]);
  });
});
