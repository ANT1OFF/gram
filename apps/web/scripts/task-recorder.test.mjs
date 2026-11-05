import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { TaskRecorder, writeTaskReport } from "../pr-shots/task-recorder.ts";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "gram-task-recorder-test-"));
  directories.push(directory);
  const page = { screenshot: async () => {} };
  return { directory, record: new TaskRecorder(page, directory, "01-example") };
};

it("retains an attempted action when the UI target fails instead of counting it as complete", async () => {
  const { record } = fixture();
  const target = {
    toString: () => 'getByRole("button", { name: "Missing" })',
    click: async () => {
      throw new Error("target unavailable");
    },
  };
  await expect(record.click(target)).rejects.toThrow("target unavailable");
  expect(record.result()).toMatchObject({
    stepCount: 1,
    steps: [{ action: "click", completed: false }],
    frames: [],
  });
});

it("counts input focus separately and records the actual text entry", async () => {
  const { record } = fixture();
  let focused = false;
  const target = {
    toString: () => 'getByLabel("Goal")',
    evaluate: async () => focused,
    click: async () => {
      focused = true;
    },
    fill: async () => {},
  };
  await record.text(target, "Synthetic goal");
  await record.text(target, "Updated goal");
  expect(record.result()).toMatchObject({
    stepCount: 3,
    steps: [
      { action: "click", completed: true },
      { action: "text", input: "Synthetic goal", completed: true },
      { action: "text", input: "Updated goal", completed: true },
    ],
  });
});

it("writes explicit outcomes, reasons and artifact links for a mixed run", () => {
  const { directory, record } = fixture();
  const tasks = [
    {
      id: "01-example",
      title: "Example",
      status: "not_possible",
      reason: "Fixture has no running turn",
      start: "Idle",
      goal: "Stop",
      video: "01.webm",
      taskStartVideoMs: 300,
      ...record.result(),
    },
  ];
  writeTaskReport(directory, { revision: "synthetic-revision" }, tasks);
  expect(JSON.parse(readFileSync(join(directory, "tasks.json"), "utf8"))).toMatchObject({
    schemaVersion: 1,
    revision: "synthetic-revision",
    tasks: [{ status: "not_possible", reason: "Fixture has no running turn", stepCount: 0 }],
  });
  expect(readFileSync(join(directory, "tasks.md"), "utf8")).toContain("[webm](01.webm)");
});
