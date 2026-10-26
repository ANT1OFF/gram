// @vitest-environment happy-dom
import type { ThreadId, ThreadSummary } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { defaultRehypePlugins } from "streamdown";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageResponse } from "@/components/ai-elements/message";
import { loadMarkdown } from "@/components/ai-elements/markdown-loader";
import { useThreadsStore } from "@/stores/threads";

import { THREAD_REF_COMPONENTS, ThreadLinkedText } from "./thread-ref-link";
import { rehypeThreadRefs } from "./thread-refs";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children?: ReactNode;
    to: string;
    params: { threadId: string };
  }) => (
    <a href={to.replace("$threadId", params.threadId)} {...rest}>
      {children}
    </a>
  ),
}));

const LIVE = "0d4f6b2a-8c1e-4f3a-9b7d-2e5c6a1f8b90";
const GONE = "4a9e2c1b-7d3f-4e8a-b6c5-1f0d9e8a7b6c";

const summary = (id: string, title: string) =>
  ({ thread: { id: id as ThreadId, title }, status: "idle" }) as ThreadSummary;

// Streamdown loads on demand; these tests are about what it renders.
beforeAll(() => loadMarkdown());

beforeEach(() => {
  useThreadsStore.setState({ ready: true, byId: { [LIVE]: summary(LIVE, "Fix the retry test") } });
});

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ ready: false, byId: {} });
});

/** The transcript's order: thread links are marked after sanitizing, before `harden`. */
const PLUGINS = [
  defaultRehypePlugins["raw"]!,
  defaultRehypePlugins["sanitize"]!,
  rehypeThreadRefs,
  defaultRehypePlugins["harden"]!,
];

const markdown = (text: string) =>
  render(
    <MessageResponse mode="static" rehypePlugins={PLUGINS} components={THREAD_REF_COMPONENTS}>
      {text}
    </MessageResponse>,
  );

describe("thread links in an agent's reply", () => {
  it("shows a known thread as a chip under its current title, linking to it", () => {
    markdown(`Handed it to [old title](#${LIVE}).`);
    const chip = screen.getByTestId("thread-ref");
    expect(chip.textContent).toBe("Fix the retry test");
    expect(chip.getAttribute("href")).toBe(`/t/${LIVE}`);
  });

  it("mutes a thread that no longer exists, without a link", () => {
    markdown(`It was [Theme spike](#${GONE}).`);
    const chip = screen.getByTestId("thread-ref");
    expect(chip.dataset["gone"]).toBe("true");
    expect(chip.textContent).toBe("Theme spike");
    expect(chip.closest("a")).toBeNull();
  });

  it("leaves an ordinary anchor the link it was", () => {
    const text = "See [setup](#setup).";
    const plain = render(<MessageResponse mode="static">{text}</MessageResponse>).container
      .innerHTML;
    cleanup();
    const { container } = markdown(text);
    expect(screen.queryByTestId("thread-ref")).toBeNull();
    expect(container.innerHTML).toBe(plain);
  });
});

describe("ThreadLinkedText", () => {
  it("chips thread links in plain text and writes the rest back as written", () => {
    const { container } = render(
      <p>
        <ThreadLinkedText
          text={`Ask [Fixer](#${LIVE}); [gone](#${GONE}) closed; [setup](#setup) stays.`}
        />
      </p>,
    );
    const chips = screen.getAllByTestId("thread-ref");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Fix the retry test", "gone"]);
    expect(chips[1]!.dataset["gone"]).toBe("true");
    expect(container.textContent).toBe(
      "Ask Fix the retry test; gone closed; [setup](#setup) stays.",
    );
  });

  it("doesn't call a thread gone before the threads have loaded", () => {
    useThreadsStore.setState({ ready: false, byId: {} });
    render(<ThreadLinkedText text={`[Theme spike](#${GONE})`} />);
    expect(screen.queryByTestId("thread-ref")).toBeNull();
    expect(screen.getByText(`[Theme spike](#${GONE})`)).toBeTruthy();
  });
});
