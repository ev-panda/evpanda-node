import { defineConfig } from "tsup";

// Dual ESM + CJS + .d.ts. Each entry maps to a subpath in package.json#exports.
// Adapters are split so consumers only pull express/ws/fetch typings when used.
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
  // Optional integrations stay external — resolved from the host app.
  external: ["express", "ws", "undici", "@mongodb-js/zstd"],
  target: "node18",
});
