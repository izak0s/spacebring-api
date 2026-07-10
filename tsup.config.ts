import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // resolve inlines openapi-fetch's types into the d.ts — it's a
  // devDependency, so consumers can't resolve an `import from "openapi-fetch"`
  // (sb.raw would silently degrade to any under skipLibCheck).
  dts: {
    resolve: ["openapi-fetch", "openapi-typescript-helpers"],
    // Neither package ships a "types" field or exports condition, so the dts
    // resolver can't find their declarations on its own; point it at the ESM
    // flavor directly. Scoped here (not tsconfig.json) because esbuild also
    // honors tsconfig paths and must keep resolving the runtime .mjs.
    compilerOptions: {
      paths: {
        "openapi-fetch": ["./node_modules/openapi-fetch/dist/index.d.mts"],
        "openapi-typescript-helpers": ["./node_modules/openapi-typescript-helpers/dist/index.d.mts"],
      },
    },
  },
  sourcemap: true,
  clean: true,
  // openapi-fetch ships a CJS build whose default export trips esbuild's
  // node-mode interop; bundling it (it's ~7 KB) sidesteps that entirely.
  noExternal: ["openapi-fetch"],
});
