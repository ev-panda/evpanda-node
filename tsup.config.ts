import { defineConfig } from "tsup";

// Dual ESM + CJS + .d.ts from a single entry, matching the one subpath in
// package.json#exports. The adapters are not separate bundles — they reach
// consumers through `src/index.ts` as the `ocpi` namespace, and their peer
// typings (express, axios) are `import type` only, so they are erased.
export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  // Embedded customer SDK: keep the bundle tiny and auditable. No runtime deps.
  // The only non-builtin the runtime touches is the optional zstd peer, loaded
  // via dynamic import and resolved from the host app. Node builtins are
  // external by default.
  external: ["@mongodb-js/zstd"],
  target: "node18",
});
