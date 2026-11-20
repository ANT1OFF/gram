import type { Locator, Page } from "@playwright/test";

/** One way of naming an element, as Playwright's user-facing locators do. */
export interface UiLocator {
  readonly testid?: string;
  readonly role?: string;
  readonly name?: string;
  readonly label?: string;
  readonly text?: string;
  readonly placeholder?: string;
  readonly exact?: boolean;
  readonly in?: UiLocator;
}

export type UiStep =
  | { readonly click: UiLocator }
  | { readonly wait: UiLocator }
  | { readonly key: string }
  | { readonly goto: string };

/** A feature's `ui` block in docs/features.json. */
export interface FeatureUi {
  readonly where: string;
  readonly route: string;
  readonly scenario?: "realistic" | "empty";
  readonly steps?: readonly UiStep[];
  readonly landmark: UiLocator;
  readonly state?: UiLocator;
}

export interface UiFeature {
  readonly name: string;
  readonly slug: string;
  readonly ui: FeatureUi;
}

export declare function featureSlug(name: string): string;
export declare function loadUiFeatures(repoRoot: string): UiFeature[];
export declare function findFeature(features: readonly UiFeature[], query: string): UiFeature;
export declare function uiProblems(name: string, ui: unknown): string[];
export declare function uiTestIds(ui: FeatureUi): string[];
export declare function locate(page: Page, spec: UiLocator): Locator;
export declare function describeLocator(spec: UiLocator): string;
export declare function seedMock(seed: { scenario: string }): void;
export declare function reach(
  page: Page,
  origin: string,
  ui: FeatureUi,
  options?: { timeout?: number },
): Promise<{ landmark: Locator; state: Locator }>;
