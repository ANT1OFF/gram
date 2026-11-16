import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolAudience } from "@gram/agents";
import { SETTINGS_CATALOGUE, USER_ONLY_SETTINGS, type ThreadId } from "@gram/contracts";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { ServerLayer } from "../http/server.ts";
import { KEYBINDINGS_ERROR_FILE, KEYBINDINGS_LAST_GOOD_FILE } from "../keybindings/keybindings.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import {
  AGENT_GUIDE_FILE,
  agentGuideText,
  guideTools,
  writeServerAgentGuide,
} from "./agent-guide.ts";

const dataDir = mkdtempSync(join(tmpdir(), "gram-agent-guide-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const AUDIENCES: ReadonlyArray<ToolAudience> = ["plain", "orchestrator", "worker", "dream"];

/** The whole server, as `main.ts` runs it: every subsystem has registered its tools once it is up. */
const server = ServerLayer.pipe(
  Layer.provide(FakeAgentAdapter),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir, appVersion: "9.9.9" })),
  Layer.orDie,
);

describe("the agent guide", () => {
  it.live(
    "names every tool any session is bound with, and every setting an agent can read",
    () =>
      Effect.gen(function* () {
        const registry = yield* AppToolRegistry;
        // Stands in for an older guide an agent or person edited: the start replaces it.
        writeFileSync(join(dataDir, AGENT_GUIDE_FILE), "stale");
        yield* writeServerAgentGuide({ dataDir, appVersion: "9.9.9" });
        const guide = readFileSync(join(dataDir, AGENT_GUIDE_FILE), "utf8");
        expect(guide).toContain("Written by Gram 9.9.9 each time it starts");
        expect(guide).toContain(dataDir);

        // What sessions are actually given, role by role, not what the guide was built from.
        const bound = new Set(
          AUDIENCES.flatMap((audience) =>
            registry
              .forThread("guide-thread" as ThreadId, audience)
              .map((tool) => tool.descriptor.name),
          ),
        );
        expect(bound.size).toBeGreaterThan(50);
        // Each role's tool list is the MCP contract: a tool added to, or dropped from, a role is a
        // deliberate change made here as well.
        const byAudience = Object.fromEntries(
          AUDIENCES.map((audience) => [
            audience,
            registry
              .forThread("guide-thread" as ThreadId, audience)
              .map((tool) => tool.descriptor.name)
              .toSorted()
              .join(" "),
          ]),
        );
        expect(byAudience).toEqual({
          plain:
            "archive_thread browser_batch browser_click browser_console browser_diagnostics browser_drag browser_evaluate browser_find browser_form_input browser_hover browser_navigate browser_network browser_press_key browser_record browser_save_screenshot browser_screenshot browser_scroll browser_scroll_to browser_snapshot browser_text browser_type browser_viewport browser_wait cancel_wake connectors_status dismiss_task get_thread git_state list_checkpoints list_events list_open_prs list_review_requests list_threads list_waits local_check mark_chapter mark_completed mcp_server_propose merge_when_ready move_to_worktree notify_user offer_page_version pr_bind pr_monitor pr_reply_to_thread pr_request_rereview pr_resolve_thread pr_review_monitor pr_review_state pr_review_threads pr_status pr_unbind preview_list preview_logs preview_start preview_stop publish_doc read_app_logs read_doc read_terminal reconnect_connector report_issue request_directory resolve_merge_fence resolve_wait restart_session restore_worktree run_monitor schedule_wake search_issues search_threads send_file send_message set_auto_merge set_connector_enabled set_plan set_thread_effort set_thread_model set_title set_unread settings_propose settings_read show_mock show_panel show_widget spawn_task stop_thread turn_diff wait_on_user workspace_create workspace_list workspace_update wrap_up",
          orchestrator:
            "add_worker_repo adopt_thread answer_worker archive_thread ask_user broadcast_message browser_batch browser_click browser_console browser_diagnostics browser_drag browser_evaluate browser_find browser_form_input browser_hover browser_navigate browser_network browser_press_key browser_record browser_save_screenshot browser_screenshot browser_scroll browser_scroll_to browser_snapshot browser_text browser_type browser_viewport browser_wait cancel_wake close_question connectors_status depends_on dismiss_task forward_question get_thread git_state list_checkpoints list_events list_open_prs list_review_requests list_threads list_waits list_workers manage_held_spawn mark_chapter mark_completed mcp_server_propose memory_append memory_delete memory_edit memory_list memory_read memory_write merge_freeze merge_when_ready move_to_worktree notify_user pr_review_state pr_status preview_list preview_logs preview_start preview_stop publish_doc read_app_logs read_doc read_terminal reconnect_connector record_user_answer report_issue request_directory resolve_merge_fence resolve_wait restart_session restore_worktree routine_create routine_update schedule_wake search_issues search_threads search_transcripts send_file send_message set_auto_merge set_connector_enabled set_group set_stage set_thread_effort set_thread_model set_title set_unread settings_propose settings_read show_mock show_panel show_widget spawn_task spawn_worker stop_thread turn_diff wait_on_user workspace_create workspace_list workspace_update",
          worker:
            "archive_thread ask_question browser_batch browser_click browser_console browser_diagnostics browser_drag browser_evaluate browser_find browser_form_input browser_hover browser_navigate browser_network browser_press_key browser_record browser_save_screenshot browser_screenshot browser_scroll browser_scroll_to browser_snapshot browser_text browser_type browser_viewport browser_wait cancel_wake connectors_status depends_on dismiss_task get_thread git_state list_checkpoints list_events list_open_prs list_review_requests list_threads list_waits local_check mark_chapter mark_completed mcp_server_propose memory_append memory_delete memory_edit memory_list memory_read memory_write merge_freeze merge_when_ready message_orchestrator move_to_worktree notify_user offer_page_version pr_bind pr_monitor pr_reply_to_thread pr_request_rereview pr_resolve_thread pr_review_monitor pr_review_state pr_review_threads pr_status pr_unbind preview_list preview_logs preview_start preview_stop publish_doc read_app_logs read_doc read_terminal reconnect_connector record_user_answer report report_issue request_directory resolve_merge_fence resolve_wait restart_session restore_worktree routine_create run_monitor schedule_wake search_issues search_threads search_transcripts send_file send_message set_auto_merge set_connector_enabled set_plan set_thread_effort set_thread_model set_title set_unread settings_read show_mock show_panel show_widget spawn_task stop_thread turn_diff wait_on_user wrap_up",
          dream:
            "dream_check dream_delete dream_edit dream_list dream_read dream_search dream_write read_transcript search_transcripts",
        });
        const missingTools = [...bound].filter((name) => !guide.includes(`### \`${name}\`\n`));
        expect(missingTools, "tools missing from the agent guide").toEqual([]);
        // One heading per name: a tool defined per role (`spawn_task`) lists each variant under it.
        for (const name of bound) expect(guide.split(`### \`${name}\`\n`)).toHaveLength(2);

        const keys = [...SETTINGS_CATALOGUE, ...USER_ONLY_SETTINGS].map((entry) => entry.key);
        const missingSettings = keys.filter((key) => !guide.includes(`| \`${key}\` |`));
        expect(missingSettings, "settings missing from the agent guide").toEqual([]);

        for (const file of [KEYBINDINGS_LAST_GOOD_FILE, KEYBINDINGS_ERROR_FILE, "kept-terminals/"])
          expect(guide).toContain(`\`${file}\``);
      }).pipe(Effect.provide(server)),
    60_000,
  );

  it("lists a tool with its class, roles and input fields", () => {
    const [tool] = guideTools([
      {
        descriptor: { name: "example_tool", class: "crossThread", description: "Does a thing." },
        input: Schema.Struct({
          threadId: Schema.String.annotate({ description: "The thread to act on." }),
          note: Schema.optionalKey(Schema.String),
        }),
        audience: ["orchestrator"],
        handle: () => Effect.void,
      },
    ]);
    const guide = agentGuideText({ dataDir: "/data", tools: [tool!] });
    const section = guide.slice(guide.indexOf("### `example_tool`"));
    expect(section).toContain("`crossThread`");
    expect(section).toContain("Roles: orchestrator.");
    expect(section).toContain("Does a thing.");
    expect(section).toContain("- `threadId` (required): The thread to act on.");
    expect(section).toMatch(/^- `note`$/m);
  });
});
