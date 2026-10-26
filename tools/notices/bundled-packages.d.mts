import type { Plugin } from "vite";

export declare const ROOT: string;
export declare const LISTS: string;
export declare const BUNDLES: readonly string[];
export declare function packageDirOf(id: string): string | undefined;
export declare function packageDirs(moduleIds: Iterable<string>, root?: string): string[];
export interface BundleChunk {
  readonly file: string;
  readonly sha256: string;
  readonly externals: readonly string[];
}
export declare function writePackageList(
  name: string,
  moduleIds: Iterable<string>,
  lists?: string,
  chunks?: readonly BundleChunk[],
): void;
export declare function bundleChunks(bundle: Record<string, unknown>): BundleChunk[];
export declare function bundledPackages(name: string): Plugin;
