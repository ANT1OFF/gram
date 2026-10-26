import type { ThreadId } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileRefResolver } from "./file-ref-resolver";
import {
  FILE_REF_TAG,
  isAbsoluteRef,
  mayBeInRoots,
  positionLabel,
  rehypeFileRefs,
} from "./file-refs";

describe("isAbsoluteRef", () => {
  it("knows the root, a drive and the home folder from a relative path", () => {
    expect(isAbsoluteRef("/tmp/a.md")).toBe(true);
    expect(isAbsoluteRef("~/a.md")).toBe(true);
    expect(isAbsoluteRef("C:\\work\\a.md")).toBe(true);
    expect(isAbsoluteRef("src/a.ts")).toBe(false);
    expect(isAbsoluteRef("a.ts")).toBe(false);
  });
});

describe("mayBeInRoots", () => {
  const roots = ["/work/api", "/work/web"];

  it("lets relative paths through and absolute ones only inside a root", () => {
    expect(mayBeInRoots("src/a.ts", roots)).toBe(true);
    expect(mayBeInRoots("/work/web/src/a.ts", roots)).toBe(true);
    expect(mayBeInRoots("/work/api-other/a.ts", roots)).toBe(false);
    expect(mayBeInRoots("/etc/passwd", roots)).toBe(false);
    expect(mayBeInRoots("~/secret.ts", roots)).toBe(false);
    expect(mayBeInRoots("C:\\work\\api\\a.ts", ["C:\\work\\api"])).toBe(true);
    expect(mayBeInRoots("/work/api/a.ts", [])).toBe(false);
  });
});

describe("positionLabel", () => {
  it("reads a line, a column or a range", () => {
    expect(positionLabel({})).toBe("");
    expect(positionLabel({ line: 4 })).toBe("4");
    expect(positionLabel({ line: 4, column: 2 })).toBe("4:2");
    expect(positionLabel({ line: 4, endLine: 9 })).toBe("4–9");
  });
});

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}
const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, children: Node[], properties: Record<string, unknown> = {}) => ({
  type: "element",
  tagName,
  properties,
  children,
});
const run = (tree: Node) => {
  rehypeFileRefs()(tree as never);
  return tree;
};

describe("rehypeFileRefs", () => {
  it("marks inline code, links and prose, and leaves code blocks alone", () => {
    const tree = run(
      el("root", [
        el("p", [
          text("Open "),
          el("code", [text("src/a.ts:3")]),
          text(" or see lib/b.ts."),
          el("a", [text("here")], { href: "src/c.ts#L2" }),
          el("code", [text("retry")]),
        ]),
        el("pre", [el("code", [text("src/a.ts:3")])]),
      ]),
    );
    const p = tree.children![0]!;
    expect(p.children!.map((node) => node.tagName ?? node.value)).toEqual([
      "Open ",
      FILE_REF_TAG,
      " or see ",
      FILE_REF_TAG,
      ".",
      FILE_REF_TAG,
      "code",
    ]);
    expect(p.children![1]!.properties).toEqual({
      dataPath: "src/a.ts",
      dataKind: "code",
      dataLine: "3",
    });
    expect(p.children![1]!.children![0]!.tagName).toBe("code");
    expect(p.children![3]!.properties).toEqual({ dataPath: "lib/b.ts", dataKind: "text" });
    expect(p.children![5]!.properties).toMatchObject({ dataPath: "src/c.ts", dataKind: "link" });
    expect(p.children![5]!.children).toEqual([text("here")]);
    expect(tree.children![1]!.children![0]!.tagName).toBe("code");
  });

  it("marks a path outside the checkout in inline code, but not a URL in one", () => {
    const tree = run(
      el("p", [
        el("code", [text("/tmp/browser-research/REPORT.md:12")]),
        el("code", [text("https://organization.example.invalid/a/b.md")]),
        el("code", [text("0.11.0/")]),
      ]),
    );
    expect(tree.children!.map((node) => node.tagName)).toEqual([FILE_REF_TAG, "code", "code"]);
    expect(tree.children![0]!.properties).toEqual({
      dataPath: "/tmp/browser-research/REPORT.md",
      dataKind: "code",
      dataLine: "12",
    });
  });

  it("leaves a web link and a PR reference as they are", () => {
    const link = el("a", [text("docs")], { href: "https://organization.example.invalid/a.ts" });
    const pr = el("pr-ref", [text("owner/repo#1")]);
    const tree = run(el("p", [link, pr]));
    expect(tree.children).toEqual([link, pr]);
  });
});

describe("createFileRefResolver", () => {
  const threadId = "t-1" as ThreadId;
  afterEach(() => vi.useRealTimers());

  it("asks about paths requested together in one call, caches both answers, and asks again on refresh", async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async (_thread: ThreadId, paths: readonly string[]) => ({
      files: paths
        .filter((path) => path === "src/a.ts")
        .map((path) => ({ path, resolved: `/r/${path}` })),
    }));
    const resolver = createFileRefResolver(resolve, 10);
    const changes = vi.fn();
    resolver.subscribe(changes);
    resolver.request(threadId, "src/a.ts");
    resolver.request(threadId, "src/nope.ts");
    resolver.request(threadId, "src/a.ts");
    expect(resolver.get(threadId, "src/a.ts")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(threadId, ["src/a.ts", "src/nope.ts"]);
    expect(resolver.get(threadId, "src/a.ts")).toEqual({ resolved: "/r/src/a.ts" });
    expect(resolver.get(threadId, "src/nope.ts")).toBeNull();
    expect(changes).toHaveBeenCalled();

    resolver.request(threadId, "src/a.ts");
    resolver.request(threadId, "src/nope.ts");
    await vi.advanceTimersByTimeAsync(10);
    expect(resolve).toHaveBeenCalledTimes(1);

    // A found file keeps its link while it is asked about again; a missing one is forgotten.
    resolve.mockImplementationOnce(async () => ({
      files: [{ path: "src/a.ts", resolved: "/moved/src/a.ts" }],
    }));
    resolver.refresh(threadId);
    expect(resolver.get(threadId, "src/a.ts")).toEqual({ resolved: "/r/src/a.ts" });
    expect(resolver.get(threadId, "src/nope.ts")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(resolve).toHaveBeenLastCalledWith(threadId, ["src/a.ts"]);
    expect(resolver.get(threadId, "src/a.ts")).toEqual({ resolved: "/moved/src/a.ts" });
  });

  it("drops an answer asked for before a refresh, and keeps the one asked for after", async () => {
    vi.useFakeTimers();
    const answers: Array<(result: { files: { path: string; resolved: string }[] }) => void> = [];
    const resolve = vi.fn(
      (_thread: ThreadId, _paths: readonly string[]) =>
        new Promise<{ files: { path: string; resolved: string }[] }>((settle) => {
          answers.push(settle);
        }),
    );
    const resolver = createFileRefResolver(resolve, 0);
    resolver.request(threadId, "retry.ts");
    await vi.advanceTimersByTimeAsync(0);
    // The checkout changes while the first call is out.
    resolver.refresh(threadId);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolve).toHaveBeenCalledTimes(2);
    answers[1]!({ files: [{ path: "retry.ts", resolved: "/b/retry.ts" }] });
    answers[0]!({ files: [{ path: "retry.ts", resolved: "/a/retry.ts" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver.get(threadId, "retry.ts")).toEqual({ resolved: "/b/retry.ts" });
  });

  it("splits a long batch, and leaves paths plain when the server can't answer", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolve = vi.fn(async () => {
      throw new Error("NotImplemented");
    });
    const resolver = createFileRefResolver(resolve, 0);
    for (let i = 0; i < 70; i++) resolver.request(threadId, `f${i}.ts`);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolver.get(threadId, "f0.ts")).toBeNull();
  });
});
