import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // openapi-fetch ships a CJS build whose default export trips esbuild's
  // node-mode interop; bundling it (it's ~7 KB) sidesteps that entirely.
  noExternal: ["openapi-fetch"],
});
