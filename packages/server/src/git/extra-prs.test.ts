import { MAX_EXTRA_PRS, MAX_HIDDEN_PRS, type Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  addExtraPr,
  applyPrEdit,
  bindMainPr,
  editMainPr,
  hidePr,
  narrowThreadHiddenPrs,
  promoteExtraPr,
  rebindBlocker,
  removeExtraPr,
  setExtraPrMonitor,
  showHiddenPrs,
  validPrRef,
  prunedMarks,
  withMonitorMark,
} from "./extra-prs.ts";

const base = { id: "t1", title: "orchestrate" } as unknown as Thread;
const primary = { repo: "example/api", number: 412, monitor: true, reviewMonitor: true };

describe("extra PRs", () => {
  it("refuses replacing or promoting over an armed merge, including a hold", () => {
    for (const held of [false, true]) {
      const armed = {
        ...primary,
        mergeWhenReady: {
          method: "squash" as const,
          allowedBy: "autonomy" as const,
          setAt: 1,
          ...(held ? { hold: "after the release", heldBy: "orchestrator" as const } : {}),
        },
      };
      const thread = addExtraPr(
        { ...base, boundPr: armed },
        { repo: "example/web", number: 8 },
        false,
      ).thread!;
      expect(rebindBlocker(thread, { repo: "EXAMPLE/api", number: 412 })).toBeUndefined();
      expect(rebindBlocker(thread, { repo: "example/web", number: 8 })).toContain(
        "armed on example/api#412",
      );
      expect(promoteExtraPr(thread, { repo: "example/web", number: 8 }).refused).toContain(
        "armed on example/api#412",
      );
      expect(thread.boundPr?.mergeWhenReady).toEqual(armed.mergeWhenReady);
    }
  });

  it("follows a PR once, and never the thread's own", () => {
    const first = addExtraPr(
      { ...base, boundPr: primary },
      { repo: "example/web", number: 8 },
      true,
    );
    expect(first.thread?.extraPrs).toEqual([{ repo: "example/web", number: 8, monitor: true }]);
    expect(addExtraPr(first.thread!, { repo: "EXAMPLE/Web", number: 8 }, false).refused).toContain(
      "already followed",
    );
    expect(
      addExtraPr(first.thread!, { repo: "EXAMPLE/api", number: 412 }, false).refused,
    ).toContain("already this thread's");
  });

  it("stops at the cap", () => {
    let thread = base;
    for (let n = 1; n <= MAX_EXTRA_PRS; n++) {
      thread = addExtraPr(thread, { repo: "example/api", number: n }, false).thread!;
    }
    expect(addExtraPr(thread, { repo: "example/api", number: 99 }, false).refused).toContain(
      `at most ${MAX_EXTRA_PRS}`,
    );
  });

  it("drops the key with the last extra, like a thread that never had one", () => {
    const thread = addExtraPr(base, { repo: "example/web", number: 8 }, false).thread!;
    expect("extraPrs" in removeExtraPr(thread, { repo: "example/web", number: 8 })).toBe(false);
    expect(removeExtraPr(thread, { repo: "example/web", number: 9 })).toEqual(thread);
  });

  it("toggles one extra's CI watch", () => {
    const thread = addExtraPr(base, { repo: "example/web", number: 8 }, false).thread!;
    expect(
      setExtraPrMonitor(thread, { repo: "example/web", number: 8 }, true).thread?.extraPrs,
    ).toEqual([{ repo: "example/web", number: 8, monitor: true }]);
    expect(
      setExtraPrMonitor(thread, { repo: "example/web", number: 9 }, true).refused,
    ).toBeDefined();
  });

  it("promotes an extra and demotes the primary without its review monitor", () => {
    const thread = addExtraPr(
      { ...base, boundPr: primary },
      { repo: "example/web", number: 8 },
      false,
    ).thread!;
    const promoted = promoteExtraPr(thread, { repo: "example/web", number: 8 }).thread!;
    expect(promoted.boundPr).toEqual({ repo: "example/web", number: 8, monitor: false });
    expect(promoted.extraPrs).toEqual([{ repo: "example/api", number: 412, monitor: true }]);
  });

  it("won't move the primary out from under babysit mode", () => {
    const thread = addExtraPr(
      { ...base, boundPr: primary, babysit: {} as Thread["babysit"] } as Thread,
      { repo: "example/web", number: 8 },
      false,
    ).thread!;
    expect(promoteExtraPr(thread, { repo: "example/web", number: 8 }).refused).toContain("Babysit");
  });

  it("gives a PR one row: binding it as the main PR stops following it as an extra", () => {
    let thread = addExtraPr(
      { ...base, boundPr: primary },
      { repo: "example/web", number: 8 },
      true,
    ).thread!;
    thread = addExtraPr(thread, { repo: "example/web", number: 9 }, false).thread!;
    const bound = bindMainPr(thread, { repo: "EXAMPLE/web", number: 8, monitor: false });
    expect(bound.boundPr).toEqual({ repo: "EXAMPLE/web", number: 8, monitor: false });
    expect(bound.extraPrs).toEqual([{ repo: "example/web", number: 9, monitor: false }]);
  });

  it("validates a reference", () => {
    expect(validPrRef({ repo: "example/api", number: 1 })).toBe(true);
    expect(validPrRef({ repo: "not a repo", number: 1 })).toBe(false);
    expect(validPrRef({ repo: "example/api", number: 0 })).toBe(false);
  });

  it("edits the row the store reads, so two edits in flight both land and a late one is refused", async () => {
    // A store whose transaction, like `ThreadStore.updateThread`, hands `f` the latest row.
    let row = { ...base, boundPr: primary } as Thread;
    const updateThread = (_id: Thread["id"], f: (thread: Thread) => Thread) =>
      Effect.sync(() => (row = f(row)));
    const follow = (number: number) =>
      applyPrEdit(updateThread, base.id, (t) =>
        addExtraPr(t, { repo: "example/web", number }, false),
      );

    // Both effects are built from the same starting thread before either runs.
    const [first, second, again] = [follow(8), follow(9), follow(8)];
    expect((await Effect.runPromise(first)).refused).toBeUndefined();
    expect((await Effect.runPromise(second)).refused).toBeUndefined();
    expect(row.extraPrs?.map((extra) => extra.number)).toEqual([8, 9]);

    const late = await Effect.runPromise(again);
    expect(late.refused).toContain("already followed");
    expect(late.thread.extraPrs).toHaveLength(2);
  });

  it("a monitor toggle built before a promotion lands edits the promoted PR, not the old one", async () => {
    let row = addExtraPr(
      { ...base, boundPr: primary },
      { repo: "example/web", number: 8 },
      false,
    ).thread!;
    const updateThread = (_id: Thread["id"], f: (thread: Thread) => Thread) =>
      Effect.sync(() => (row = f(row)));
    // Both are built while #412 is still the main PR.
    const toggle = applyPrEdit(
      updateThread,
      base.id,
      editMainPr((bound) => ({ ...bound, monitor: false })),
    );
    const promote = applyPrEdit(updateThread, base.id, (t) =>
      promoteExtraPr(t, { repo: "example/web", number: 8 }),
    );

    await Effect.runPromise(promote);
    await Effect.runPromise(toggle);
    expect(row.boundPr).toEqual({ repo: "example/web", number: 8, monitor: false });
    expect(row.extraPrs).toEqual([{ repo: "example/api", number: 412, monitor: true }]);
  });

  it("hides a PR's row without touching its binding, once per PR and up to the cap", () => {
    const bound = { ...base, boundPr: primary };
    const hidden = hidePr(hidePr(bound, { repo: "example/api", number: 412, state: "OPEN" }), {
      repo: "EXAMPLE/Api",
      number: 412,
      state: "OPEN",
      seen: ["conflicts"],
    });
    expect(hidden.boundPr).toEqual(primary);
    expect(hidden.hiddenPrs).toEqual([
      { repo: "EXAMPLE/Api", number: 412, state: "OPEN", seen: ["conflicts"] },
    ]);
    let full = hidden;
    for (let n = 1; n <= MAX_HIDDEN_PRS; n++)
      full = hidePr(full, { repo: "example/web", number: n });
    expect(full.hiddenPrs).toHaveLength(MAX_HIDDEN_PRS);
    expect(full.hiddenPrs?.[0]).toEqual({ repo: "example/web", number: 1 });
    expect("hiddenPrs" in showHiddenPrs(full)).toBe(false);
    expect(showHiddenPrs(full).boundPr).toEqual(primary);
  });

  it("narrows hidden PRs to their badges, and hands back the same thread when none moved", () => {
    const badge = {
      number: 412,
      state: "OPEN",
      url: "https://github.com/example/api/pull/412",
      title: "t",
      isDraft: false,
      checks: "pending",
      headMatches: true,
      aheadOfPr: false,
      headRefOid: "h1",
    } as const;
    const hidden = hidePr(base, {
      repo: "example/api",
      number: 412,
      state: "OPEN",
      seen: ["ci:h1"],
    });
    expect(narrowThreadHiddenPrs(hidden, [badge]).hiddenPrs).toEqual([
      { repo: "example/api", number: 412, state: "OPEN" },
    ]);
    const failing = { ...badge, checks: "failing" } as const;
    expect(narrowThreadHiddenPrs(hidden, [failing])).toBe(hidden);
    expect(narrowThreadHiddenPrs(base, [badge])).toBe(base);
  });

  it("refuses to edit a main PR the thread doesn't have", async () => {
    const edit = editMainPr((bound) => ({ ...bound, monitor: true }))(base);
    expect(edit.refused).toContain("no pull request is bound");
  });
});

describe("monitor marks", () => {
  const seen = { head: "a1", ci: "passing", checks: "pending", reviewId: "PRR_1" } as const;

  it("sets a mark on the PR it names, and changes nothing when it says the same", () => {
    const thread: Thread = {
      ...base,
      boundPr: { repo: "acme/web", number: 7, monitor: true },
      extraPrs: [{ repo: "acme/api", number: 3, monitor: true }],
    };
    const marked = withMonitorMark(thread, { repo: "ACME/api", number: 3 }, { ci: "failing" });
    expect(marked.extraPrs?.[0]?.seen).toEqual({ ci: "failing" });
    expect(marked.boundPr?.seen).toBeUndefined();
    expect(withMonitorMark(marked, { repo: "acme/api", number: 3 }, { ci: "failing" })).toBe(
      marked,
    );
    expect(withMonitorMark(thread, { repo: "acme/web", number: 8 }, { ci: "failing" })).toBe(
      thread,
    );
  });

  it("keeps only what the monitors still on wrote", () => {
    const both: Thread = {
      ...base,
      boundPr: { repo: "acme/web", number: 7, monitor: true, reviewMonitor: true, seen },
    };
    // With the review monitor on, the CI monitor stands aside.
    expect(prunedMarks(both).boundPr?.seen).toEqual({
      head: "a1",
      checks: "pending",
      reviewId: "PRR_1",
    });
    const ciOnly: Thread = {
      ...base,
      boundPr: { repo: "acme/web", number: 7, monitor: true, seen },
    };
    expect(prunedMarks(ciOnly).boundPr?.seen).toEqual({ head: "a1", ci: "passing" });
    const off: Thread = { ...base, boundPr: { repo: "acme/web", number: 7, monitor: false, seen } };
    expect(prunedMarks(off).boundPr).toEqual({ repo: "acme/web", number: 7, monitor: false });
    const kept = prunedMarks(ciOnly);
    expect(prunedMarks(kept)).toBe(kept);
  });
});
