// Ambient module shims for the wb-ui plugin sources that ce-api-shim.ts
// reaches across-submodule via relative path. The wb-ui package owns its
// own deps (vite / sharp / DOM lib), but server tsconfig has none of those
// — when tsc walks into the wb-ui source files through these relative
// imports, every wb-ui-internal reference (vite types, sharp module,
// localStorage, etc.) reports as missing in server's program.
//
// Declaring the imported entry points as ambient (`any`) keeps ce-api-shim
// typechecking against a generic surface while leaving wb-ui's own
// typecheck (run inside marketplace's pipeline) the canonical authority on
// its API. The runtime call works because esbuild/bun strip types and the
// wb-ui package's runtime files are present.
//
// Remove these shims when ce-api-shim moves to a versioned npm-style
// import or when wb-ui is hoisted into a workspace package whose tsconfig
// inherits server's lib + types.

// ce-api-shim's relative-path imports cause tsc to typecheck wb-ui's source
// files inside server's program. wb-ui owns `vite` / `sharp` / DOM lib in
// its own package; server has none of these, so wb-ui-internal references
// red out under server. Declare them as global ambient modules so server's
// program can resolve them against an `any` shape; wb-ui's own typecheck
// (run inside marketplace's pipeline) remains the canonical authority on
// these surfaces.
declare module 'vite' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface Plugin {
    name?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configureServer?: (server: any) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value: any;
  export = value;
}

// `sharp` is consumed both as a default-imported callable AND as a
// namespace (e.g. `sharp.Metadata`, `sharp.KernelEnum`); declare it as a
// global namespace plus a module export to satisfy both shapes.
declare namespace sharp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type KernelEnum = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Metadata = any;
}
declare module 'sharp' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type KernelEnum = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Metadata = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sharp: any;
  export default sharp;
}

// wb-ui/src/pipelines/ui-design/model.ts touches `localStorage` directly.
// server's lib is ES2022 (no DOM); declare the global manually so the file
// typechecks here without dragging the entire DOM lib in via tsconfig.
declare const localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};
