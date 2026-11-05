import { mkdirSync, writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

/** One click, key chord or contiguous text entry is one step. Setup and assertions aren't steps. */
export class TaskRecorder {
  readonly steps: {
    action: string;
    target: string;
    input?: string | undefined;
    atMs: number;
    completed: boolean;
  }[] = [];
  readonly frames: string[] = [];
  readonly deadEnds: string[] = [];
  private started = performance.now();
  private captureMs = 0;

  readonly page: Page;
  readonly directory: string;
  readonly id: string;
  constructor(page: Page, directory: string, id: string) {
    this.page = page;
    this.directory = directory;
    this.id = id;
    mkdirSync(directory, { recursive: true });
  }

  async frame() {
    const start = performance.now();
    const file = `${this.id}-${String(this.frames.length).padStart(2, "0")}.png`;
    await this.page.screenshot({ path: `${this.directory}/${file}`, animations: "disabled" });
    this.frames.push(file);
    this.captureMs += performance.now() - start;
  }

  private async action(action: string, target: string, run: () => Promise<void>, input?: string) {
    const step = {
      action,
      target,
      input,
      atMs: Math.round(performance.now() - this.started),
      completed: false,
    };
    this.steps.push(step);
    await run();
    step.completed = true;
    await this.frame();
  }

  click(target: Locator) {
    return this.action("click", target.toString(), () => target.click());
  }
  async text(target: Locator, text: string) {
    if (!(await target.evaluate((element) => element === document.activeElement)))
      await this.click(target);
    return this.action("text", target.toString(), () => target.fill(text), text);
  }
  key(chord: string, target?: Locator) {
    return this.action(
      "key",
      target?.toString() ?? "keyboard",
      () => (target ? target.press(chord) : this.page.keyboard.press(chord)),
      chord,
    );
  }
  result() {
    const wallMs = Math.round(performance.now() - this.started);
    return {
      stepCount: this.steps.length,
      steps: this.steps,
      elapsedMs: wallMs - Math.round(this.captureMs),
      wallMs,
      captureMs: Math.round(this.captureMs),
      deadEnds: this.deadEnds,
      frames: this.frames,
    };
  }
}

export function writeTaskReport(
  directory: string,
  metadata: object,
  tasks: Record<string, unknown>[],
) {
  writeFileSync(
    `${directory}/tasks.json`,
    JSON.stringify({ schemaVersion: 1, ...metadata, tasks }, null, 2) + "\n",
  );
  const lines = [
    "# Scripted task runs",
    "",
    "Synthetic browser fixture; no live agents or accounts. One click, chord or text entry = one step. Setup is excluded. elapsedMs excludes PNG capture overhead; it includes UI waits and is automation time, not human speed. Video includes setup; taskStartVideoMs locates the measured start. Failures retain attempted steps and never become 'not possible'.",
    "",
  ];
  for (const task of tasks) {
    lines.push(
      `## ${task.id}: ${task.title}`,
      "",
      `Status: **${task.status}**. Steps: ${task.stepCount}. Elapsed: ${task.elapsedMs} ms.`,
      "",
      `Start: ${task.start}. Goal: ${task.goal}.`,
      "",
    );
    if (task.reason) lines.push(`Reason: ${task.reason}`, "");
    for (const step of task.steps as TaskRecorder["steps"])
      lines.push(
        `- ${step.action}: ${step.target}${step.input ? ` → ${step.input}` : ""}${step.completed ? "" : " (failed)"}`,
      );
    lines.push(
      "",
      `Dead ends: ${(task.deadEnds as string[]).join("; ") || "none observed"}.`,
      "",
      `Recording: [webm](${task.video}) (task starts about ${task.taskStartVideoMs} ms in).`,
      "",
      ...(task.frames as string[]).map((file) => `[${file}](${file})`),
      "",
    );
  }
  writeFileSync(`${directory}/tasks.md`, lines.join("\n") + "\n");
}
