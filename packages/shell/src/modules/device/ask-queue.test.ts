import { displayCommand } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { ASK_ARM_MS } from "./ask-page.ts";
import { type AskSurface, makeAskQueue } from "./ask-queue.ts";
import { askView } from "./ask-view.ts";
import type { AskRequest } from "./gate.ts";

const request = (requestId: string, command = "npm test"): AskRequest => ({
  approval: {
    origin: "https://gram.example.com",
    workspace: "w1",
    requestId,
    kind: "exec",
    folder: "/home/ada/code/app",
    target: "/home/ada/code/app",
    command,
    timeoutMs: 120_000,
  },
  hash: `hash-${requestId}`,
  folderLabel: "app",
  display: displayCommand(command),
  thread: { id: "t1", title: "Fix the build" },
  actorName: "Ada",
  othersWrote: false,
  grantIssuedAt: new Date(2026, 10, 11, 14, 2).getTime(),
});

/** A window that records what it was told. */
const fakeSurface = () => {
  const shown: Array<{ show: string; command: string }> = [];
  const withdrawn: Array<string> = [];
  let hidden = 0;
  const surface: AskSurface = {
    show: async (show, view) => {
      shown.push({
        show,
        command: view.target.pieces.map((piece) => ("text" in piece ? piece.text : "")).join(""),
      });
    },
    withdraw: (show) => withdrawn.push(show),
    hide: () => {
      hidden += 1;
    },
  };
  return { surface, shown, withdrawn, hidden: () => hidden };
};

const setUp = () => {
  const clock = { at: 0 };
  const fake = fakeSurface();
  const notified: Array<string> = [];
  const queue = makeAskQueue({
    surface: fake.surface,
    view: (asked) => askView({ request: asked, machine: "this computer" }),
    notify: (view) => notified.push(view.heading),
    elapsed: () => clock.at,
  });
  return { queue, fake, clock, notified };
};

const tick = () => new Promise((later) => setTimeout(later, 0));

describe("the asks, one at a time", () => {
  it("shows one ask, allows it only after a full second, and then shows the next", async () => {
    const { queue, fake, clock, notified } = setUp();
    const first = queue.ask(request("r1"), new AbortController().signal);
    const second = queue.ask(request("r2", "make"), new AbortController().signal);
    await tick();
    expect(fake.shown.map((item) => item.command)).toEqual(["npm test"]);
    expect(notified).toEqual(["Run a command"]);
    const show = fake.shown[0]?.show ?? "";
    clock.at += ASK_ARM_MS - 1;
    queue.answered(show, "allow");
    await tick();
    expect(queue.waiting()).toBe(2);
    clock.at += 1;
    queue.answered(show, "allow");
    expect(await first).toEqual({ allowed: true, hash: "hash-r1" });
    await tick();
    expect(fake.shown.map((item) => item.command)).toEqual(["npm test", "make"]);
    // An answer for an ask no longer on screen counts for nothing.
    clock.at += ASK_ARM_MS;
    queue.answered(show, "allow");
    queue.answered(fake.shown[1]?.show ?? "", "refuse");
    expect(await second).toEqual({ allowed: false });
    await tick();
    expect(fake.hidden()).toBe(1);
  });

  it("keeps an ask taken back on screen as withdrawn until the person dismisses it", async () => {
    const { queue, fake, clock } = setUp();
    const takeBack = new AbortController();
    const first = queue.ask(request("r1"), takeBack.signal);
    const second = queue.ask(request("r2", "make"), new AbortController().signal);
    await tick();
    const show = fake.shown[0]?.show ?? "";
    takeBack.abort();
    expect(await first).toEqual({ allowed: false });
    expect(fake.withdrawn).toEqual([show]);
    // Nothing slides into its place: an allow there does nothing, and the next waits.
    clock.at += ASK_ARM_MS * 2;
    queue.answered(show, "allow");
    await tick();
    expect(fake.shown).toHaveLength(1);
    queue.answered(show, "dismiss");
    await tick();
    expect(fake.shown.map((item) => item.command)).toEqual(["npm test", "make"]);
    queue.close();
    expect(await second).toEqual({ allowed: false });
  });

  it("drops an ask taken back while it waited, and refuses everything when closed", async () => {
    const { queue, fake } = setUp();
    const waitingBack = new AbortController();
    void queue.ask(request("r1"), new AbortController().signal);
    const second = queue.ask(request("r2"), waitingBack.signal);
    await tick();
    waitingBack.abort();
    expect(await second).toEqual({ allowed: false });
    expect(queue.waiting()).toBe(1);
    queue.close();
    expect(queue.waiting()).toBe(0);
    expect(await queue.ask(request("r3"), new AbortController().signal)).toEqual({
      allowed: false,
    });
    expect(fake.shown).toHaveLength(1);
  });

  it("never sticks: a withdrawal while drawing, a failed draw, a window gone, a view that throws", async () => {
    // Withdrawn while the window was still drawing it: marked again once drawn, and a refusal
    // lets it go.
    let draw: (() => void) | undefined;
    let fail: (() => void) | undefined;
    const withdrawn: Array<string> = [];
    const shown: Array<string> = [];
    const clock = { at: 0 };
    let views = 0;
    const queue = makeAskQueue({
      surface: {
        show: (show) =>
          new Promise<void>((done, failed) => {
            shown.push(show);
            draw = done;
            fail = () => failed(new Error("gone"));
          }),
        withdraw: (show) => withdrawn.push(show),
        hide: () => undefined,
      },
      view: (asked) => {
        views += 1;
        if (asked.approval.requestId === "broken") throw new Error("no view");
        return askView({ request: asked, machine: "this computer" });
      },
      notify: () => {
        throw new Error("no notifications");
      },
      elapsed: () => clock.at,
    });
    const takeBack = new AbortController();
    const first = queue.ask(request("r1"), takeBack.signal);
    const second = queue.ask(request("r2"), new AbortController().signal);
    const third = queue.ask(request("r3"), new AbortController().signal);
    const broken = queue.ask(request("broken"), new AbortController().signal);
    const fourth = queue.ask(request("r4"), new AbortController().signal);
    await tick();
    takeBack.abort();
    expect(await first).toEqual({ allowed: false });
    draw?.();
    await tick();
    expect(withdrawn).toEqual([shown[0], shown[0]]);
    queue.answered(shown[0] ?? "", "refuse");
    await tick();
    expect(shown).toHaveLength(2);
    // A draw that fails after nothing answered: refused, and the next is drawn.
    fail?.();
    expect(await second).toEqual({ allowed: false });
    await tick();
    expect(shown).toHaveLength(3);
    // The window goes with the ask on it: refused, and the next is drawn.
    // A window gone late, for an ask no longer on screen, changes nothing.
    queue.gone(shown[1] ?? "");
    expect(shown).toHaveLength(3);
    queue.gone(shown[2] ?? "");
    expect(await third).toEqual({ allowed: false });
    // A view that throws is refused, and the queue moves on past it.
    expect(await broken).toEqual({ allowed: false });
    await tick();
    expect(shown).toHaveLength(4);
    expect(views).toBe(5);
    clock.at += ASK_ARM_MS;
    queue.answered(shown[3] ?? "", "allow");
    expect(await fourth).toEqual({ allowed: true, hash: "hash-r4" });
  });

  it("refuses an ask the window couldn't draw", async () => {
    const clock = { at: 0 };
    const queue = makeAskQueue({
      surface: {
        show: async () => {
          throw new Error("gone");
        },
        withdraw: () => undefined,
        hide: () => undefined,
      },
      view: (asked) => askView({ request: asked, machine: "this computer" }),
      notify: () => undefined,
      elapsed: () => clock.at,
    });
    expect(await queue.ask(request("r1"), new AbortController().signal)).toEqual({
      allowed: false,
    });
  });
});

describe("what the ask says", () => {
  it("keeps what the app vouches for apart from what the server says", () => {
    const view = askView({
      request: { ...request("r1", "echo a‮b && ./run.sh"), reason: "To check", othersWrote: true },
      machine: "this Mac",
      local: () => "14:02",
    });
    expect(view.server).toBe("https://gram.example.com");
    expect(view.folderPath).toBe("/home/ada/code/app");
    expect(view.grantLine).toBe("You wrote to this thread from this Mac at 14:02.");
    expect(view.says.map((item) => item.label)).toEqual(["Workspace", "Thread", "Asked by", "Why"]);
    expect(view.warnings).toEqual(
      expect.arrayContaining([
        "This has characters you can't see, drawn as codes.",
        "The server says someone else also wrote to this thread since you did.",
      ]),
    );
    expect(view.facts).toEqual(
      expect.arrayContaining(["Runs echo, ./run.sh", "Runs code from this folder (./run.sh)"]),
    );
    expect(view.allowLabel).toBe("Run once");
  });

  it("shows a read's real path and size, and never a clean bill for a command", () => {
    const read = askView({
      request: {
        ...request("r1"),
        approval: {
          ...request("r1").approval,
          kind: "read",
          target: "/home/ada/code/app/a.md",
          command: "",
        },
        size: 2048,
      },
      machine: "this computer",
    });
    expect(read.target.pieces).toEqual([{ kind: "text", text: "/home/ada/code/app/a.md" }]);
    expect(read.size).toBe("2.0 KB");
    expect(read.facts).toEqual([]);
    const plain = askView({ request: request("r2", "true"), machine: "this computer" });
    expect(plain.facts).toEqual(["Runs true"]);
    const changed = askView({
      request: request("r3", "ls"),
      machine: "this computer",
      folderChanged: true,
    });
    expect(changed.facts).toContain("The folder changed since you last allowed a command here.");
  });
});
