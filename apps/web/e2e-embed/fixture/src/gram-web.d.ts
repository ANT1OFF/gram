// The package's entry, typed from its source: the build's own declarations (`dist-embed`) say the
// same from `contract.ts`, and exist only once it has been built.
declare module "gram-web" {
  export * from "@/embed/index";
}
declare module "gram-web/style.css";
declare module "gram-web/kit" {
  export * from "@/embed/kit";
}
declare module "gram-web/kit-lite" {
  export * from "@/embed/kit-lite";
}
declare module "gram-web/kit-lite.css";
