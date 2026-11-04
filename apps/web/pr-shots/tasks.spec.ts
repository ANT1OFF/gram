import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { seedMockSettings } from "./shots";
import { SET_SIZE, stageRealistic } from "./tour";
import { TaskRecorder, writeTaskReport } from "./task-recorder";
import { TASKS } from "./tasks";

const directory = fileURLToPath(new URL("out/tasks/", import.meta.url));
const modes = (process.env["GRAM_PR_SHOTS_MODES"] || "dark").split(",");
const only = (process.env["GRAM_PR_SHOTS_ONLY"] || "").split(",").filter(Boolean);
for (const id of only)
  if (!TASKS.some((task) => task.id === id)) throw new Error(`Unknown task: ${id}`);

const source =
  process.env["GRAM_PR_SHOTS_WEB_DIR"] || fileURLToPath(new URL("../", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
}).trim();
const metadata = {
  app: "Gram",
  revision,
  capturedAt: new Date().toISOString(),
  viewport: SET_SIZE,
  evidence: "scripted synthetic mock",
  timing: "automation time, excluding setup and PNG capture; not human or provider latency",
};

test.use({ viewport: SET_SIZE, video: { mode: "on", size: SET_SIZE } });
for (const task of TASKS.filter((candidate) => only.length === 0 || only.includes(candidate.id))) {
  for (const mode of modes) {
    test(`${task.id}-${mode}`, async ({ page }) => {
      const pageCreated = performance.now();
      let record: TaskRecorder | undefined;
      let error: unknown;
      let taskStartVideoMs = 0;
      const id = `${task.id}-${mode}`;
      try {
        await stageRealistic(page);
        await seedMockSettings(page, {
          appearance: { motion: "off", mode },
          panel: { open: false },
        });
        await page.addInitScript(() => {
          sessionStorage.setItem("gram.mock.agents", "claude,codex");
          sessionStorage.setItem(
            "gram.mock.launchChecks",
            JSON.stringify({
              claudeSignIn: "signedIn",
              codexSignIn: "signedIn",
              ghSignedIn: false,
            }),
          );
        });
        if (task.id === "11-stop")
          await page.addInitScript(() => {
            window.gramMockHoldGates = true;
          });
        await page.goto(task.path ?? "/t/t-deps");
        await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
        await task.prepare?.(page);
        await page.evaluate(() => document.fonts.ready);
        taskStartVideoMs = Math.round(performance.now() - pageCreated);
        record = new TaskRecorder(page, directory, id);
        await record.frame();
        await task.run(page, record);
      } catch (caught) {
        error = caught;
      } finally {
        record ??= new TaskRecorder(page, directory, id);
        if (error) record.deadEnds.push(String(error).split("\n")[0]!);
        await record.frame().catch(() => {});
        const outcome = record.result();
        const video = `${id}.webm`;
        const recording = page.video();
        await page.close();
        await recording?.saveAs(`${directory}/${video}`);
        const result = {
          id,
          title: task.title,
          start: task.start,
          goal: task.goal,
          mode,
          status: error ? "failed" : "completed",
          ...(error ? { reason: String(error).split("\n")[0] } : {}),
          taskStartVideoMs,
          video,
          ...outcome,
        };
        writeFileSync(`${directory}/${id}.task.json`, JSON.stringify(result));
        const results = readdirSync(directory)
          .filter((file) => file.endsWith(".task.json"))
          .toSorted()
          .map(
            (file) =>
              JSON.parse(readFileSync(`${directory}/${file}`, "utf8")) as Record<string, unknown>,
          );
        writeTaskReport(directory, metadata, results);
      }
      if (error) throw error;
    });
  }
}
