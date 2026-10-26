export declare const DEFAULT_SERVER_PORT: number;
export declare const DEFAULT_WEB_PORT: number;

interface FindOptions {
  readonly attempts?: number;
  readonly isFree?: (port: number) => Promise<boolean>;
}

export declare function isPortFree(port: number): Promise<boolean>;
export declare function findFreePort(start: number, options?: FindOptions): Promise<number>;
export declare function resolvePort(
  envValue: string | undefined,
  defaultPort: number,
  options?: FindOptions,
): Promise<number>;
export declare const webOrigins: (webPort: number) => string;
export declare function devBootUrl(serverBootUrl: string, webPort: number): string;
export declare function checkoutPort(
  dir: string,
  options?: { readonly base?: number; readonly slots?: number; readonly stride?: number },
): number;
