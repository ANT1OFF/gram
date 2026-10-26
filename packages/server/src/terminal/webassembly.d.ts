/**
 * The slice of the WebAssembly JS API `plain-text.ts` uses. Node has the API, but `@types/node`
 * doesn't describe it, and the libs that do (`dom`, `webworker`) would bring a browser's globals
 * into the server's type-check.
 */
declare namespace WebAssembly {
  interface Module {
    readonly [Symbol.toStringTag]: "WebAssembly.Module";
  }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  function compile(bytes: ArrayBuffer | ArrayBufferView): Promise<Module>;
  function instantiate(
    module: Module,
    imports?: Record<string, Record<string, unknown>>,
  ): Promise<Instance>;
}
