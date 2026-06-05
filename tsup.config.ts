import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Preserve the `#!/usr/bin/env node` shebang from src/index.ts so the built
  // file is directly executable as the `opencli` bin.
  banner: { js: "" },
  // better-sqlite3 is a native addon; never try to bundle it.
  external: ["better-sqlite3"],
});
