// @vitest-environment happy-dom
import { DEFAULT_CHARTER, DEFAULT_SETTINGS } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useServerSettings } from "@/settings-sync/store";
import { MergeReviewPolicyField } from "./merge-review-policy-field";

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});
const addOverride = (repo: string, policy: string) => {
  fireEvent.change(screen.getByLabelText("Repository (owner/repo)"), {
    target: { value: repo },
  });
  fireEvent.change(screen.getByLabelText("Policy for the new override"), {
    target: { value: policy },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add override" }));
};

describe("workspace merge policy editor", () => {
  it("shows migrated bot policy without silently saving a new default", () => {
    const onChange = vi.fn();
    const { mergeReviewPolicy: _, ...migrated } = DEFAULT_CHARTER;
    render(<MergeReviewPolicyField charter={migrated} disabled={false} onChange={onChange} />);
    expect(
      screen.getByRole("radio", { name: "Require review bot" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("saves a Gram override without changing workspace policy or other overrides", () => {
    const onChange = vi.fn();
    const charter = {
      ...DEFAULT_CHARTER,
      mergeReviewPolicy: "bot",
      repoMergeReviewPolicies: [{ repo: "owner/other", policy: "bot" }],
    } as const;
    render(<MergeReviewPolicyField charter={charter} disabled={false} onChange={onChange} />);
    addOverride("ANT1OFF/gram", "solo");
    expect(onChange).toHaveBeenCalledWith({
      ...charter,
      repoMergeReviewPolicies: [
        ...charter.repoMergeReviewPolicies,
        { repo: "ANT1OFF/gram", policy: "solo" },
      ],
    });
  });
  it("changes and removes one override as a row", () => {
    const onChange = vi.fn();
    const charter = {
      ...DEFAULT_CHARTER,
      repoMergeReviewPolicies: [
        { repo: "owner/other", policy: "bot" },
        { repo: "ANT1OFF/gram", policy: "solo" },
      ],
    } as const;
    render(<MergeReviewPolicyField charter={charter} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Policy for owner/other"), {
      target: { value: "automatic" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...charter,
      repoMergeReviewPolicies: [
        { repo: "owner/other", policy: "automatic" },
        { repo: "ANT1OFF/gram", policy: "solo" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove the override for owner/other" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...charter,
      repoMergeReviewPolicies: [{ repo: "ANT1OFF/gram", policy: "solo" }],
    });
    // Removing the last one leaves no list behind.
    const { repoMergeReviewPolicies: _, ...bare } = charter;
    cleanup();
    render(
      <MergeReviewPolicyField
        charter={{ ...bare, repoMergeReviewPolicies: [{ repo: "ANT1OFF/gram", policy: "solo" }] }}
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove the override for ANT1OFF/gram" }));
    expect(onChange).toHaveBeenLastCalledWith(bare);
  });
  it("reads back resolved Gram and inherited bot policies", () => {
    useServerSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        reviewBots: [
          { loginPattern: "configured[bot]", rereviewCommand: "/review", canApprove: true },
        ],
      },
    });
    const charter = {
      ...DEFAULT_CHARTER,
      repoMergeReviewPolicies: [{ repo: "ANT1OFF/gram", policy: "solo" }],
    } as const;
    render(<MergeReviewPolicyField charter={charter} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByTestId("resolved-merge-review-policy").textContent).toContain(
      "Resolves to bot now.",
    );
    expect(screen.getByTestId("repo-override").textContent).toContain("solo");
  });
  it("refuses invalid and duplicate repo scopes", () => {
    const onChange = vi.fn();
    render(
      <MergeReviewPolicyField
        charter={{
          ...DEFAULT_CHARTER,
          repoMergeReviewPolicies: [{ repo: "ANT1OFF/gram", policy: "solo" }],
        }}
        disabled={false}
        onChange={onChange}
      />,
    );
    for (const repo of ["ANT1OFF/*", "ANT1OFF/gram extra", "https://github.com/a/b", "a/.."]) {
      addOverride(repo, "solo");
      expect(screen.getByRole("alert").textContent).toContain("exact owner/repo");
    }
    addOverride("ant1off/GRAM", "bot");
    expect(screen.getByRole("alert").textContent).toContain("already has an override");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("preserves charter fields when explicitly changing workspace policy", () => {
    const onChange = vi.fn();
    render(
      <MergeReviewPolicyField charter={DEFAULT_CHARTER} disabled={false} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Solo development" }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_CHARTER, mergeReviewPolicy: "solo" });
  });
  it("prevents stale charter saves while another save is running", () => {
    const onChange = vi.fn();
    render(<MergeReviewPolicyField charter={DEFAULT_CHARTER} disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Solo development" }));
    expect(screen.getByLabelText("Repository (owner/repo)").hasAttribute("disabled")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
